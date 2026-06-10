package relay

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"nhooyr.io/websocket"

	"github.com/anthropics/agentplex/relay/api"
)

// ClientConn represents a connected remote device (iOS, web, Android).
type ClientConn struct {
	DeviceID  string
	MachineID string // the machine this device is connected to
	ws        *websocket.Conn
	hub       *Hub
	mu        sync.Mutex
	closed    bool
}

// NewClientConn creates a client connection.
func NewClientConn(deviceID string, ws *websocket.Conn, hub *Hub) *ClientConn {
	return &ClientConn{
		DeviceID: deviceID,
		ws:       ws,
		hub:      hub,
	}
}

// ReadLoop reads messages from the device and routes them to the target machine.
// Blocks until the connection is closed.
func (cc *ClientConn) ReadLoop(ctx context.Context) {
	defer func() {
		cc.hub.UnregisterClient(cc.DeviceID)
		cc.Close()
	}()

	for {
		_, data, err := cc.ws.Read(ctx)
		if err != nil {
			if !cc.closed {
				log.Printf("[client] %s read error: %v", cc.DeviceID, err)
			}
			return
		}

		cc.handleMessage(ctx, data)
	}
}

func (cc *ClientConn) handleMessage(ctx context.Context, data []byte) {
	var peek struct {
		Type      string `json:"type"`
		To        string `json:"to"`
		MachineID string `json:"machineId"`
	}
	if err := json.Unmarshal(data, &peek); err != nil {
		return
	}

	switch peek.Type {
	case "connect":
		// Device wants to connect to a specific machine
		cc.handleConnect(peek.MachineID)

	case "envelope":
		// Device is sending an encrypted message to its machine
		if cc.MachineID == "" {
			cc.sendError("NOT_CONNECTED", "send a 'connect' message first")
			return
		}
		// Inject the "from" field
		var envelope map[string]interface{}
		if err := json.Unmarshal(data, &envelope); err != nil {
			return
		}
		envelope["from"] = cc.DeviceID
		enriched, err := json.Marshal(envelope)
		if err != nil {
			return
		}
		if !cc.hub.RouteToMachine(cc.MachineID, enriched) {
			cc.sendError("MACHINE_OFFLINE", "target machine is not connected")
		}

	case "ping":
		pong, _ := json.Marshal(api.PongMessage{Type: "pong"})
		cc.Send(pong)
	}
}

func (cc *ClientConn) handleConnect(machineID string) {
	if machineID == "" {
		cc.sendError("INVALID_REQUEST", "machineId is required")
		return
	}

	// Verify this device is paired with the target machine
	device, err := cc.hub.store.GetDevice(cc.DeviceID)
	if err != nil {
		cc.sendError("DEVICE_NOT_FOUND", "device not registered")
		return
	}
	if device.Revoked {
		cc.sendError("DEVICE_REVOKED", "device has been revoked")
		return
	}
	if device.MachineID != machineID {
		cc.sendError("NOT_PAIRED", "device is not paired with this machine")
		return
	}

	cc.MachineID = machineID
	cc.hub.RegisterClient(cc.DeviceID, cc)

	// Send connected confirmation
	msg := api.ConnectedEvent{
		Type:      "connected",
		MachineID: machineID,
	}
	data, _ := json.Marshal(msg)
	cc.Send(data)

	// Tell the client if the machine is online or offline
	online := cc.hub.IsMachineOnline(machineID)
	status := "machine:offline"
	if online {
		status = "machine:online"
	}
	statusMsg, _ := json.Marshal(api.MachineStatusEvent{
		Type:      status,
		MachineID: machineID,
	})
	cc.Send(statusMsg)
}

func (cc *ClientConn) sendError(code, message string) {
	data, _ := json.Marshal(api.ErrorMessage{
		Type:    "error",
		Code:    code,
		Message: message,
	})
	cc.Send(data)
}

// Send writes a message to the client's WebSocket.
func (cc *ClientConn) Send(data []byte) bool {
	cc.mu.Lock()
	defer cc.mu.Unlock()

	if cc.closed {
		return false
	}

	err := cc.ws.Write(context.Background(), websocket.MessageText, data)
	if err != nil {
		log.Printf("[client] %s write error: %v", cc.DeviceID, err)
		return false
	}
	return true
}

// Close closes the WebSocket connection.
func (cc *ClientConn) Close() {
	cc.mu.Lock()
	defer cc.mu.Unlock()

	if cc.closed {
		return
	}
	cc.closed = true
	cc.ws.Close(websocket.StatusNormalClosure, "closing")
}

package relay

import (
	"context"
	"encoding/json"
	"log"
	"sync"

	"nhooyr.io/websocket"
)

// MachineConn represents a connected AgentPlex desktop instance.
type MachineConn struct {
	MachineID string
	ws        *websocket.Conn
	hub       *Hub
	mu        sync.Mutex
	closed    bool
}

// NewMachineConn creates a machine connection and starts its read loop.
func NewMachineConn(machineID string, ws *websocket.Conn, hub *Hub) *MachineConn {
	mc := &MachineConn{
		MachineID: machineID,
		ws:        ws,
		hub:       hub,
	}
	return mc
}

// ReadLoop reads messages from the machine and routes them to target devices.
// Blocks until the connection is closed.
func (mc *MachineConn) ReadLoop(ctx context.Context) {
	defer func() {
		mc.hub.UnregisterMachine(mc.MachineID)
		mc.Close()
	}()

	for {
		_, data, err := mc.ws.Read(ctx)
		if err != nil {
			if !mc.closed {
				log.Printf("[machine] %s read error: %v", mc.MachineID, err)
			}
			return
		}

		mc.handleMessage(data)
	}
}

func (mc *MachineConn) handleMessage(data []byte) {
	// Peek at the type field to determine routing
	var peek struct {
		Type string `json:"type"`
		To   string `json:"to"`
	}
	if err := json.Unmarshal(data, &peek); err != nil {
		return
	}

	switch peek.Type {
	case "envelope":
		// Machine is sending an encrypted message to a device
		if peek.To == "" {
			return
		}
		// Inject the "from" field so the device knows the source
		var envelope map[string]interface{}
		if err := json.Unmarshal(data, &envelope); err != nil {
			return
		}
		envelope["from"] = mc.MachineID
		enriched, err := json.Marshal(envelope)
		if err != nil {
			return
		}
		mc.hub.RouteToClient(peek.To, enriched)

	case "ping":
		pong, _ := json.Marshal(map[string]string{"type": "pong"})
		mc.Send(pong)
	}
}

// Send writes a message to the machine's WebSocket. Returns false if the
// connection is closed or the buffer is too full.
func (mc *MachineConn) Send(data []byte) bool {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if mc.closed {
		return false
	}

	err := mc.ws.Write(context.Background(), websocket.MessageText, data)
	if err != nil {
		log.Printf("[machine] %s write error: %v", mc.MachineID, err)
		return false
	}
	return true
}

// Close closes the WebSocket connection.
func (mc *MachineConn) Close() {
	mc.mu.Lock()
	defer mc.mu.Unlock()

	if mc.closed {
		return
	}
	mc.closed = true
	mc.ws.Close(websocket.StatusNormalClosure, "closing")
}

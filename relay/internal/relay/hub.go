// Package relay implements the WebSocket connection hub that routes encrypted
// envelopes between AgentPlex machines and paired remote devices.
package relay

import (
	"encoding/json"
	"log"
	"sync"

	"github.com/anthropics/agentplex/relay/api"
	"github.com/anthropics/agentplex/relay/internal/audit"
	"github.com/anthropics/agentplex/relay/internal/store"
)

// Hub manages all active WebSocket connections and routes messages between them.
type Hub struct {
	mu       sync.RWMutex
	machines map[string]*MachineConn // machineID → connection
	clients  map[string]*ClientConn  // deviceID → connection
	store    store.Store
	audit    *audit.Logger
}

// NewHub creates a new relay hub.
func NewHub(s store.Store, a *audit.Logger) *Hub {
	return &Hub{
		machines: make(map[string]*MachineConn),
		clients:  make(map[string]*ClientConn),
		store:    s,
		audit:    a,
	}
}

// RegisterMachine adds a machine connection to the hub.
func (h *Hub) RegisterMachine(machineID string, conn *MachineConn) {
	h.mu.Lock()
	old := h.machines[machineID]
	h.machines[machineID] = conn
	h.mu.Unlock()
	if old != nil {
		old.Close()
	}

	h.store.TouchMachine(machineID)

	// Notify connected clients that this machine is now online
	h.notifyClientsOfMachineStatus(machineID, true)

	log.Printf("[hub] Machine registered: %s", machineID)
}

// UnregisterMachine removes a machine connection from the hub.
func (h *Hub) UnregisterMachine(machineID string, conn *MachineConn) {
	h.mu.Lock()
	if h.machines[machineID] != conn {
		h.mu.Unlock()
		return
	}
	delete(h.machines, machineID)
	h.mu.Unlock()

	// Notify connected clients that this machine went offline
	h.notifyClientsOfMachineStatus(machineID, false)

	log.Printf("[hub] Machine unregistered: %s", machineID)
}

// RegisterClient adds a device client connection to the hub.
func (h *Hub) RegisterClient(deviceID string, conn *ClientConn) {
	h.mu.Lock()
	old := h.clients[deviceID]
	h.clients[deviceID] = conn
	h.mu.Unlock()
	if old != nil {
		old.Close()
	}

	h.store.TouchDevice(deviceID)

	log.Printf("[hub] Client registered: %s (target: %s)", deviceID, conn.MachineID)
}

// UnregisterClient removes a device client connection from the hub.
func (h *Hub) UnregisterClient(deviceID string, conn *ClientConn) {
	h.mu.Lock()
	if h.clients[deviceID] != conn {
		h.mu.Unlock()
		return
	}
	delete(h.clients, deviceID)
	h.mu.Unlock()

	log.Printf("[hub] Client unregistered: %s", deviceID)
}

// RouteToMachine forwards a raw message from a device to its target machine.
func (h *Hub) RouteToMachine(machineID string, raw []byte) bool {
	h.mu.RLock()
	machine, ok := h.machines[machineID]
	h.mu.RUnlock()

	if !ok || machine == nil {
		return false
	}
	return machine.Send(raw)
}

// RouteToClient forwards a raw message from a machine to a specific device.
func (h *Hub) RouteToClient(deviceID string, raw []byte) bool {
	h.mu.RLock()
	client, ok := h.clients[deviceID]
	h.mu.RUnlock()

	if !ok || client == nil {
		return false
	}
	return client.Send(raw)
}

// IsMachineOnline checks if a machine is currently connected.
func (h *Hub) IsMachineOnline(machineID string) bool {
	h.mu.RLock()
	_, ok := h.machines[machineID]
	h.mu.RUnlock()
	return ok
}

// IsClientOnline checks if a remote device currently has an active connection.
func (h *Hub) IsClientOnline(deviceID string) bool {
	h.mu.RLock()
	_, ok := h.clients[deviceID]
	h.mu.RUnlock()
	return ok
}

// DisconnectClient immediately terminates a device connection, if present.
func (h *Hub) DisconnectClient(deviceID string) {
	h.mu.RLock()
	client := h.clients[deviceID]
	h.mu.RUnlock()
	if client != nil {
		client.Close()
	}
}

// SendToMachine sends a structured message to a machine's WebSocket.
func (h *Hub) SendToMachine(machineID string, msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	h.RouteToMachine(machineID, data)
}

// notifyClientsOfMachineStatus tells all clients connected to a machine
// about its online/offline status change.
func (h *Hub) notifyClientsOfMachineStatus(machineID string, online bool) {
	eventType := "machine:offline"
	if online {
		eventType = "machine:online"
	}

	msg := api.MachineStatusEvent{
		Type:      eventType,
		MachineID: machineID,
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	h.mu.RLock()
	clients := make([]*ClientConn, 0, len(h.clients))
	for _, client := range h.clients {
		if client.MachineID == machineID {
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range clients {
		client.Send(data)
	}
}

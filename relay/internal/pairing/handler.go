package pairing

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/anthropics/agentplex/relay/api"
	"github.com/anthropics/agentplex/relay/internal/audit"
	"github.com/anthropics/agentplex/relay/internal/auth"
	"github.com/anthropics/agentplex/relay/internal/store"
)

const maxPairingAttempts = 5

// Handler handles pairing HTTP endpoints.
type Handler struct {
	store   store.Store
	audit   *audit.Logger
	jwt     *auth.JWTManager
	// OnPairCompleted is called when a device completes pairing.
	// The relay hub uses this to notify the machine over WebSocket.
	OnPairCompleted func(machineID string, event api.PairCompletedEvent)
}

// NewHandler creates a new pairing handler.
func NewHandler(s store.Store, a *audit.Logger, j *auth.JWTManager) *Handler {
	return &Handler{store: s, audit: a, jwt: j}
}

// Initiate handles POST /pair/initiate (machine-authenticated).
// The machine sends the hash of a code it displayed to the user.
func (h *Handler) Initiate(w http.ResponseWriter, r *http.Request, machineID string) {
	var req api.PairInitiateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.CodeHash == "" || req.MachineEncryptionKey == "" {
		jsonError(w, http.StatusBadRequest, "codeHash and machineEncryptionKey are required")
		return
	}

	ttl := req.TTL
	if ttl <= 0 || ttl > 600 {
		ttl = 300 // default 5 minutes
	}

	id := randomID()
	pr := store.PairingRequest{
		ID:                   id,
		MachineID:            machineID,
		CodeHash:             req.CodeHash,
		MachineEncryptionKey: req.MachineEncryptionKey,
		ExpiresAt:            time.Now().Add(time.Duration(ttl) * time.Second),
	}

	if err := h.store.CreatePairingRequest(pr); err != nil {
		log.Printf("[pairing] Failed to create request: %v", err)
		jsonError(w, http.StatusInternalServerError, "failed to create pairing request")
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "expiresIn": ttl})
}

// Complete handles POST /pair/complete (the code itself is the auth).
// A device submits the code + its public keys to complete pairing.
func (h *Handler) Complete(w http.ResponseWriter, r *http.Request) {
	var req api.PairCompleteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.MachineID == "" || req.Code == "" || req.DevicePublicKey == "" || req.DeviceEncryptionKey == "" {
		jsonError(w, http.StatusBadRequest, "machineId, code, devicePublicKey, and deviceEncryptionKey are required")
		return
	}

	// Find active pairing request for this machine
	pr, err := h.store.GetPairingRequestByMachine(req.MachineID)
	if err != nil {
		jsonError(w, http.StatusNotFound, "no active pairing request for this machine")
		return
	}

	// Check expiry
	if time.Now().After(pr.ExpiresAt) {
		jsonError(w, http.StatusGone, "pairing code expired")
		return
	}

	// Check attempts
	if pr.Attempts >= maxPairingAttempts {
		jsonError(w, http.StatusTooManyRequests, "too many attempts, request a new code")
		return
	}

	// Increment attempts before checking code (prevents brute force)
	h.store.IncrementPairingAttempts(pr.ID)

	// Verify code hash
	if HashCode(req.Code) != pr.CodeHash {
		h.audit.Log(audit.EventAuthFail, req.MachineID, "", remoteAddr(r), map[string]string{
			"reason": "invalid_pairing_code",
		})
		jsonError(w, http.StatusUnauthorized, "invalid pairing code")
		return
	}

	// Code matches — create the device
	deviceID := "dev-" + randomID()
	device := store.Device{
		DeviceID:    deviceID,
		PublicKey:   req.DevicePublicKey,
		EncryptionKey: req.DeviceEncryptionKey,
		DisplayName: req.Name,
		Platform:    req.Platform,
		MachineID:   req.MachineID,
	}

	if err := h.store.CreateDevice(device); err != nil {
		log.Printf("[pairing] Failed to create device: %v", err)
		jsonError(w, http.StatusInternalServerError, "failed to create device")
		return
	}

	// Mark pairing request as completed
	h.store.CompletePairingRequest(pr.ID)

	h.audit.Log(audit.EventPair, req.MachineID, deviceID, remoteAddr(r), map[string]string{
		"platform": req.Platform,
		"name":     req.Name,
	})

	// Notify the machine over WebSocket
	if h.OnPairCompleted != nil {
		h.OnPairCompleted(req.MachineID, api.PairCompletedEvent{
			Type:                "pair:completed",
			DeviceID:            deviceID,
			DeviceEncryptionKey: req.DeviceEncryptionKey,
			Name:                req.Name,
			Platform:            req.Platform,
		})
	}

	resp := api.PairCompleteResponse{
		DeviceID:             deviceID,
		MachineID:            req.MachineID,
		MachineEncryptionKey: pr.MachineEncryptionKey,
	}
	jsonResponse(w, http.StatusOK, resp)
}

func randomID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func remoteAddr(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return xff
	}
	return r.RemoteAddr
}

func jsonError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(api.ErrorMessage{Type: "error", Code: http.StatusText(status), Message: message})
}

func jsonResponse(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

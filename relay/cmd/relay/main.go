// AgentPlex Relay Server
//
// A blind relay that routes E2EE encrypted envelopes between AgentPlex desktop
// instances and paired remote devices (web, iOS). The relay cannot read any
// terminal data — it only sees encrypted blobs and connection metadata.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"nhooyr.io/websocket"

	"github.com/anthropics/agentplex/relay/api"
	"github.com/anthropics/agentplex/relay/internal/audit"
	"github.com/anthropics/agentplex/relay/internal/auth"
	"github.com/anthropics/agentplex/relay/internal/pairing"
	"github.com/anthropics/agentplex/relay/internal/relay"
	"github.com/anthropics/agentplex/relay/internal/store"
)

const version = "0.1.0"

func main() {
	addr := envOr("LISTEN_ADDR", ":8080")
	dbPath := envOr("DB_PATH", "./relay.db")
	signingKey := os.Getenv("JWT_SIGNING_KEY") // hex-encoded Ed25519 seed (optional, generated if empty)

	log.Printf("[relay] AgentPlex Relay v%s starting...", version)

	// --- Database ---
	db, err := store.NewSQLiteStore(dbPath)
	if err != nil {
		log.Fatalf("[relay] Failed to open database: %v", err)
	}
	defer db.Close()
	log.Printf("[relay] Database opened: %s", dbPath)

	// --- Audit ---
	auditLog := audit.New(db.DB())

	// --- Auth ---
	jwtMgr, err := auth.NewJWTManager(signingKey, db)
	if err != nil {
		log.Fatalf("[relay] Failed to initialize JWT manager: %v", err)
	}
	log.Printf("[relay] JWT manager initialized")

	// --- Relay Hub ---
	hub := relay.NewHub(db, auditLog)

	// --- Pairing ---
	pairingHandler := pairing.NewHandler(db, auditLog, jwtMgr)
	pairingHandler.OnPairCompleted = func(machineID string, event api.PairCompletedEvent) {
		hub.SendToMachine(machineID, event)
	}

	// --- HTTP Router ---
	mux := http.NewServeMux()

	// Health (no auth)
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		jsonResp(w, http.StatusOK, api.HealthResponse{Status: "ok", Version: version})
	})

	// Machine registration (no auth — first contact)
	mux.HandleFunc("POST /register/machine", func(w http.ResponseWriter, r *http.Request) {
		var req api.RegisterMachineRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.MachineID == "" || req.PublicKey == "" {
			jsonErr(w, http.StatusBadRequest, "machineId and publicKey are required")
			return
		}

		// Check if machine already exists (idempotent registration)
		if existing, _ := db.GetMachine(req.MachineID); existing != nil {
			jsonResp(w, http.StatusOK, api.RegisterMachineResponse{MachineID: req.MachineID, OK: true})
			return
		}

		m := store.Machine{
			MachineID:     req.MachineID,
			PublicKey:     req.PublicKey,
			EncryptionKey: req.EncryptionKey,
			DisplayName:   req.DisplayName,
		}
		if err := db.CreateMachine(m); err != nil {
			log.Printf("[register] Failed: %v", err)
			jsonErr(w, http.StatusInternalServerError, "registration failed")
			return
		}
		auditLog.Log(audit.EventRegister, req.MachineID, "", remoteAddr(r), nil)
		log.Printf("[register] Machine registered: %s", req.MachineID)
		jsonResp(w, http.StatusCreated, api.RegisterMachineResponse{MachineID: req.MachineID, OK: true})
	})

	// Auth challenge (no auth)
	mux.HandleFunc("POST /auth/challenge", func(w http.ResponseWriter, r *http.Request) {
		var req api.ChallengeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.ID == "" {
			jsonErr(w, http.StatusBadRequest, "id is required")
			return
		}

		challenge, err := auth.CreateChallenge(db, req.ID)
		if err != nil {
			log.Printf("[auth] Challenge creation failed: %v", err)
			jsonErr(w, http.StatusInternalServerError, "failed to create challenge")
			return
		}
		jsonResp(w, http.StatusOK, api.ChallengeResponse{Challenge: challenge})
	})

	// Auth token exchange (signed challenge)
	mux.HandleFunc("POST /auth/token", func(w http.ResponseWriter, r *http.Request) {
		var req api.TokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, http.StatusBadRequest, "invalid request body")
			return
		}
		if req.ID == "" || req.Signature == "" {
			jsonErr(w, http.StatusBadRequest, "id and signature are required")
			return
		}

		// Look up the public key — could be a machine or device
		var publicKey string
		var subjectType string

		if m, err := db.GetMachine(req.ID); err == nil {
			publicKey = m.PublicKey
			subjectType = "machine"
		} else if d, err := db.GetDevice(req.ID); err == nil {
			if d.Revoked {
				jsonErr(w, http.StatusUnauthorized, "device has been revoked")
				return
			}
			publicKey = d.PublicKey
			subjectType = "device"
		} else {
			auditLog.Log(audit.EventAuthFail, "", "", remoteAddr(r), map[string]string{
				"reason": "unknown_subject", "id": req.ID,
			})
			jsonErr(w, http.StatusUnauthorized, "unknown subject")
			return
		}

		if err := auth.VerifySignature(db, req.ID, req.Signature, publicKey); err != nil {
			auditLog.Log(audit.EventAuthFail, req.ID, "", remoteAddr(r), map[string]string{
				"reason": "bad_signature",
			})
			jsonErr(w, http.StatusUnauthorized, "signature verification failed")
			return
		}

		access, refresh, expiresIn, err := jwtMgr.IssueTokens(req.ID, subjectType)
		if err != nil {
			log.Printf("[auth] Token issuance failed: %v", err)
			jsonErr(w, http.StatusInternalServerError, "token issuance failed")
			return
		}

		jsonResp(w, http.StatusOK, api.TokenResponse{
			AccessToken:  access,
			RefreshToken: refresh,
			ExpiresIn:    expiresIn,
		})
	})

	// Refresh token
	mux.HandleFunc("POST /auth/refresh", func(w http.ResponseWriter, r *http.Request) {
		var req api.RefreshRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			jsonErr(w, http.StatusBadRequest, "invalid request body")
			return
		}
		access, expiresIn, err := jwtMgr.RefreshAccessToken(req.RefreshToken)
		if err != nil {
			jsonErr(w, http.StatusUnauthorized, "invalid or expired refresh token")
			return
		}
		jsonResp(w, http.StatusOK, map[string]interface{}{
			"accessToken": access,
			"expiresIn":   expiresIn,
		})
	})

	// Pairing initiate (machine-authenticated)
	mux.HandleFunc("POST /pair/initiate", func(w http.ResponseWriter, r *http.Request) {
		claims := requireAuth(w, r, jwtMgr, "machine")
		if claims == nil {
			return
		}
		pairingHandler.Initiate(w, r, claims.Subject)
	})

	// Pairing complete (code is the auth — no JWT needed)
	mux.HandleFunc("POST /pair/complete", func(w http.ResponseWriter, r *http.Request) {
		pairingHandler.Complete(w, r)
	})

	// List devices for a machine (machine-authenticated)
	mux.HandleFunc("GET /devices", func(w http.ResponseWriter, r *http.Request) {
		claims := requireAuth(w, r, jwtMgr, "machine")
		if claims == nil {
			return
		}
		devices, err := db.ListDevicesForMachine(claims.Subject)
		if err != nil {
			jsonErr(w, http.StatusInternalServerError, "failed to list devices")
			return
		}
		result := make([]api.DeviceInfo, 0, len(devices))
		for _, d := range devices {
			result = append(result, api.DeviceInfo{
				DeviceID: d.DeviceID,
				Name:     d.DisplayName,
				Platform: d.Platform,
				PairedAt: d.PairedAt.Format(time.RFC3339),
				LastSeen: d.LastSeen.Format(time.RFC3339),
				IsOnline: hub.IsMachineOnline(d.DeviceID), // check if device is connected
			})
		}
		jsonResp(w, http.StatusOK, result)
	})

	// Revoke a device (machine-authenticated)
	mux.HandleFunc("DELETE /devices/{deviceId}", func(w http.ResponseWriter, r *http.Request) {
		claims := requireAuth(w, r, jwtMgr, "machine")
		if claims == nil {
			return
		}
		deviceID := r.PathValue("deviceId")

		// Verify the device belongs to this machine
		device, err := db.GetDevice(deviceID)
		if err != nil {
			jsonErr(w, http.StatusNotFound, "device not found")
			return
		}
		if device.MachineID != claims.Subject {
			jsonErr(w, http.StatusForbidden, "device does not belong to this machine")
			return
		}

		if err := db.RevokeDevice(deviceID); err != nil {
			jsonErr(w, http.StatusInternalServerError, "failed to revoke device")
			return
		}
		auditLog.Log(audit.EventUnpair, claims.Subject, deviceID, remoteAddr(r), nil)
		jsonResp(w, http.StatusOK, map[string]bool{"ok": true})
	})

	// Machine status (device-authenticated)
	mux.HandleFunc("GET /machines/{machineId}/status", func(w http.ResponseWriter, r *http.Request) {
		claims := requireAuth(w, r, jwtMgr, "device")
		if claims == nil {
			return
		}
		machineID := r.PathValue("machineId")

		// Verify device is paired with this machine
		device, err := db.GetDevice(claims.Subject)
		if err != nil || device.MachineID != machineID {
			jsonErr(w, http.StatusForbidden, "not paired with this machine")
			return
		}

		machine, err := db.GetMachine(machineID)
		if err != nil {
			jsonErr(w, http.StatusNotFound, "machine not found")
			return
		}

		jsonResp(w, http.StatusOK, api.MachineStatus{
			MachineID: machineID,
			Online:    hub.IsMachineOnline(machineID),
			LastSeen:  machine.LastSeen.Format(time.RFC3339),
		})
	})

	// --- WebSocket endpoint ---
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		// Extract JWT from Authorization header or query param
		tokenStr := extractToken(r)
		if tokenStr == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		claims, err := jwtMgr.ValidateAccessToken(tokenStr)
		if err != nil {
			http.Error(w, "invalid token", http.StatusUnauthorized)
			return
		}

		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			InsecureSkipVerify: true, // CORS handled by Cloudflare; allow any origin
		})
		if err != nil {
			log.Printf("[ws] Accept error: %v", err)
			return
		}

		ctx := r.Context()
		clientIP := remoteAddr(r)

		switch claims.Type {
		case "machine":
			auditLog.Log(audit.EventConnect, claims.Subject, "", clientIP, map[string]string{"type": "machine"})
			conn := relay.NewMachineConn(claims.Subject, ws, hub)
			hub.RegisterMachine(claims.Subject, conn)
			conn.ReadLoop(ctx) // blocks until disconnect
			auditLog.Log(audit.EventDisconnect, claims.Subject, "", clientIP, map[string]string{"type": "machine"})

		case "device":
			auditLog.Log(audit.EventConnect, "", claims.Subject, clientIP, map[string]string{"type": "device"})
			conn := relay.NewClientConn(claims.Subject, ws, hub)
			conn.ReadLoop(ctx) // blocks until disconnect
			auditLog.Log(audit.EventDisconnect, "", claims.Subject, clientIP, map[string]string{"type": "device"})

		default:
			ws.Close(websocket.StatusPolicyViolation, "unknown token type")
		}
	})

	// --- CORS middleware ---
	handler := corsMiddleware(mux)

	// --- Server ---
	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGTERM)

	go func() {
		log.Printf("[relay] Listening on %s", addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatalf("[relay] Server error: %v", err)
		}
	}()

	// Background cleanup: expired pairing requests
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			db.CleanExpiredPairings()
		}
	}()

	<-done
	log.Println("[relay] Shutting down...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	srv.Shutdown(ctx)
	log.Println("[relay] Stopped")
}

// --- Helpers ---

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func extractToken(r *http.Request) string {
	// Check Authorization header
	if auth := r.Header.Get("Authorization"); auth != "" {
		if strings.HasPrefix(auth, "Bearer ") {
			return auth[7:]
		}
	}
	// Check query param (for WebSocket connections)
	return r.URL.Query().Get("token")
}

func requireAuth(w http.ResponseWriter, r *http.Request, jwtMgr *auth.JWTManager, requiredType string) *auth.Claims {
	tokenStr := extractToken(r)
	if tokenStr == "" {
		jsonErr(w, http.StatusUnauthorized, "missing authorization")
		return nil
	}
	claims, err := jwtMgr.ValidateAccessToken(tokenStr)
	if err != nil {
		jsonErr(w, http.StatusUnauthorized, "invalid or expired token")
		return nil
	}
	if requiredType != "" && claims.Type != requiredType {
		jsonErr(w, http.StatusForbidden, fmt.Sprintf("requires %s token", requiredType))
		return nil
	}
	return claims
}

func remoteAddr(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP (client IP behind Cloudflare)
		if idx := strings.Index(xff, ","); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	return r.RemoteAddr
}

func jsonResp(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

func jsonErr(w http.ResponseWriter, status int, message string) {
	jsonResp(w, status, api.ErrorMessage{Type: "error", Code: http.StatusText(status), Message: message})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

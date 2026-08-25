// Package api defines the shared message types for the AgentPlex relay protocol.
package api

// --- WebSocket messages (Client ↔ Relay) ---

// Envelope is an E2EE encrypted message routed between machine and device.
// The relay forwards it without reading the contents.
type Envelope struct {
	Type  string `json:"type"`  // always "envelope"
	To    string `json:"to"`    // target machineId or deviceId
	From  string `json:"from"`  // set by relay on outbound
	Epoch string `json:"epoch"` // sender epoch, authenticated as AAD
	Seq   uint64 `json:"seq"`   // monotonic sender sequence
	Nonce string `json:"nonce"` // base64-encoded 96-bit nonce
	CT    string `json:"ct"`    // base64-encoded ciphertext + poly1305 tag
}

// ConnectMessage is sent by a device to connect to a specific machine.
type ConnectMessage struct {
	Type      string `json:"type"`      // "connect"
	MachineID string `json:"machineId"` // target machine
}

// PingMessage is a keepalive.
type PingMessage struct {
	Type string `json:"type"` // "ping"
}

// --- Relay → Client events ---

// ConnectedEvent confirms a device is connected to a machine.
type ConnectedEvent struct {
	Type      string `json:"type"` // "connected"
	MachineID string `json:"machineId"`
}

// MachineStatusEvent indicates a machine came online or went offline.
type MachineStatusEvent struct {
	Type      string `json:"type"` // "machine:online" or "machine:offline"
	MachineID string `json:"machineId"`
}

// PairCompletedEvent notifies the machine that a device completed pairing.
type PairCompletedEvent struct {
	Type                string `json:"type"` // "pair:completed"
	DeviceID            string `json:"deviceId"`
	DevicePublicKey     string `json:"devicePublicKey"`
	DeviceEncryptionKey string `json:"deviceEncryptionKey"` // X25519 public key, base64
	CodeHash            string `json:"codeHash"`
	DeviceProof         string `json:"deviceProof"`
	Name                string `json:"name"`
	Platform            string `json:"platform"`
}

// PongMessage is a keepalive response.
type PongMessage struct {
	Type string `json:"type"` // "pong"
}

// ErrorMessage reports an error to the client.
type ErrorMessage struct {
	Type    string `json:"type"` // "error"
	Code    string `json:"code"`
	Message string `json:"message"`
}

// --- HTTP request/response types ---

// ChallengeRequest is POST /auth/challenge.
type ChallengeRequest struct {
	ID string `json:"id"` // machineId or deviceId
}

// ChallengeResponse is the response to POST /auth/challenge.
type ChallengeResponse struct {
	Challenge string `json:"challenge"` // base64-encoded random bytes
}

// TokenRequest is POST /auth/token.
type TokenRequest struct {
	ID        string `json:"id"`        // machineId or deviceId
	Signature string `json:"signature"` // base64 Ed25519 signature over the challenge
}

// TokenResponse is the response to POST /auth/token.
type TokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"` // seconds
}

// RefreshRequest is POST /auth/refresh.
type RefreshRequest struct {
	RefreshToken string `json:"refreshToken"`
}

// RegisterMachineRequest is POST /register/machine.
type RegisterMachineRequest struct {
	MachineID     string `json:"machineId"`
	PublicKey     string `json:"publicKey"`     // Ed25519 public key, base64
	EncryptionKey string `json:"encryptionKey"` // X25519 public key, base64
	DisplayName   string `json:"displayName"`
}

// RegisterMachineResponse is the response to POST /register/machine.
type RegisterMachineResponse struct {
	MachineID string `json:"machineId"`
	OK        bool   `json:"ok"`
}

// PairInitiateRequest is POST /pair/initiate (machine-authenticated).
type PairInitiateRequest struct {
	CodeHash             string `json:"codeHash"`             // SHA-256 hex of the out-of-band secret
	MachineEncryptionKey string `json:"machineEncryptionKey"` // X25519 public key, base64
	MachineProof         string `json:"machineProof"`         // HMAC binding machine identity and key
	TTL                  int    `json:"ttl"`                  // seconds until code expires
}

// PairCompleteRequest is POST /pair/complete (code is the auth).
type PairCompleteRequest struct {
	MachineID           string `json:"machineId"`
	CodeHash            string `json:"codeHash"`
	DevicePublicKey     string `json:"devicePublicKey"`     // Ed25519 public key, base64
	DeviceEncryptionKey string `json:"deviceEncryptionKey"` // X25519 public key, base64
	DeviceProof         string `json:"deviceProof"`         // HMAC binding the complete key transcript
	Platform            string `json:"platform"`            // "ios" | "web" | "android"
	Name                string `json:"name"`                // e.g. "Alex's iPhone"
}

// PairCompleteResponse is the response to POST /pair/complete.
type PairCompleteResponse struct {
	DeviceID             string `json:"deviceId"`
	MachineID            string `json:"machineId"`
	MachineEncryptionKey string `json:"machineEncryptionKey"` // X25519 public key, base64
	MachineProof         string `json:"machineProof"`
}

// PairInfoResponse lets a device authenticate the machine key before it submits
// its own key proof. Possession of the high-entropy code hash locates the request.
type PairInfoResponse struct {
	MachineID            string `json:"machineId"`
	MachineEncryptionKey string `json:"machineEncryptionKey"`
	MachineProof         string `json:"machineProof"`
}

// DeviceInfo is returned by GET /devices.
type DeviceInfo struct {
	DeviceID      string `json:"deviceId"`
	Name          string `json:"name"`
	Platform      string `json:"platform"`
	PairedAt      string `json:"pairedAt"`
	LastSeen      string `json:"lastSeen"`
	IsOnline      bool   `json:"isOnline"`
	EncryptionKey string `json:"encryptionKey"`
	PublicKey     string `json:"publicKey"`
	CodeHash      string `json:"codeHash"`
	PairingProof  string `json:"pairingProof"`
}

// MachineStatus is returned by GET /machines/:id/status.
type MachineStatus struct {
	MachineID string `json:"machineId"`
	Online    bool   `json:"online"`
	LastSeen  string `json:"lastSeen"`
}

// HealthResponse is returned by GET /health.
type HealthResponse struct {
	Status  string `json:"status"`
	Version string `json:"version"`
}

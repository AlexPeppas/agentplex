// Package store defines the persistence interface for the relay server.
package store

import "time"

// Machine represents a registered AgentPlex desktop instance.
type Machine struct {
	MachineID     string
	PublicKey     string // Ed25519, base64
	EncryptionKey string // X25519, base64
	DisplayName   string
	RegisteredAt  time.Time
	LastSeen      time.Time
}

// Device represents a paired remote client (iOS, web, Android).
type Device struct {
	DeviceID      string
	PublicKey     string // Ed25519, base64
	EncryptionKey string // X25519, base64
	DisplayName   string
	Platform      string // "ios" | "web" | "android"
	MachineID     string
	PairedAt      time.Time
	LastSeen      time.Time
	Revoked       bool
}

// PairingRequest represents an in-flight pairing flow.
type PairingRequest struct {
	ID        string
	MachineID string
	CodeHash  string
	MachineEncryptionKey string
	ExpiresAt time.Time
	Attempts  int
	Completed bool
}

// Store is the persistence interface for the relay.
type Store interface {
	// Machines
	CreateMachine(m Machine) error
	GetMachine(machineID string) (*Machine, error)
	TouchMachine(machineID string) error // update last_seen

	// Devices
	CreateDevice(d Device) error
	GetDevice(deviceID string) (*Device, error)
	ListDevicesForMachine(machineID string) ([]Device, error)
	RevokeDevice(deviceID string) error
	TouchDevice(deviceID string) error // update last_seen

	// Pairing
	CreatePairingRequest(p PairingRequest) error
	GetPairingRequestByMachine(machineID string) (*PairingRequest, error)
	IncrementPairingAttempts(id string) error
	CompletePairingRequest(id string) error
	CleanExpiredPairings() error

	// Auth
	StoreRefreshToken(token string, subjectID string, expiresAt time.Time) error
	ValidateRefreshToken(token string) (subjectID string, err error)
	RevokeRefreshToken(token string) error

	// Challenges
	StoreChallenge(id string, challenge string, expiresAt time.Time) error
	ConsumeChallenge(id string) (challenge string, err error)

	Close() error
}

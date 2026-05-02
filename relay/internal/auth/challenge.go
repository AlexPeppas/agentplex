package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"time"

	"github.com/anthropics/agentplex/relay/internal/store"
)

const challengeBytes = 32
const challengeTTL = 60 * time.Second

// CreateChallenge generates a random challenge for the given subject and stores it.
func CreateChallenge(s store.Store, subjectID string) (string, error) {
	buf := make([]byte, challengeBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("generate challenge: %w", err)
	}

	challenge := base64.StdEncoding.EncodeToString(buf)
	if err := s.StoreChallenge(subjectID, challenge, time.Now().Add(challengeTTL)); err != nil {
		return "", fmt.Errorf("store challenge: %w", err)
	}
	return challenge, nil
}

// VerifySignature consumes the stored challenge for the subject and verifies
// the Ed25519 signature. Returns nil on success.
func VerifySignature(s store.Store, subjectID string, signatureB64 string, publicKeyB64 string) error {
	challenge, err := s.ConsumeChallenge(subjectID)
	if err != nil {
		return fmt.Errorf("consume challenge: %w", err)
	}

	pubKeyBytes, err := base64.StdEncoding.DecodeString(publicKeyB64)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public key")
	}

	sigBytes, err := base64.StdEncoding.DecodeString(signatureB64)
	if err != nil {
		return fmt.Errorf("invalid signature encoding")
	}

	challengeBytes, err := base64.StdEncoding.DecodeString(challenge)
	if err != nil {
		return fmt.Errorf("invalid stored challenge")
	}

	if !ed25519.Verify(ed25519.PublicKey(pubKeyBytes), challengeBytes, sigBytes) {
		return fmt.Errorf("signature verification failed")
	}

	return nil
}

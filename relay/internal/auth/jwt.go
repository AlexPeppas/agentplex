package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/anthropics/agentplex/relay/internal/store"
)

const (
	accessTokenTTL  = 15 * time.Minute
	refreshTokenTTL = 30 * 24 * time.Hour // 30 days
	issuer          = "agentplex-relay"
)

// Claims is the JWT claims structure for relay tokens.
type Claims struct {
	jwt.RegisteredClaims
	Type string `json:"type"` // "machine" or "device"
}

// JWTManager handles JWT creation and validation.
type JWTManager struct {
	privateKey ed25519.PrivateKey
	publicKey  ed25519.PublicKey
	store      store.Store
}

// NewJWTManager creates a JWTManager. If signingKey is empty, a new Ed25519
// keypair is generated (suitable for development; production should persist the key).
func NewJWTManager(signingKeyHex string, s store.Store) (*JWTManager, error) {
	var priv ed25519.PrivateKey
	var pub ed25519.PublicKey

	if signingKeyHex != "" {
		seed, err := hex.DecodeString(signingKeyHex)
		if err != nil || len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("invalid JWT_SIGNING_KEY: must be %d hex bytes", ed25519.SeedSize)
		}
		priv = ed25519.NewKeyFromSeed(seed)
		pub = priv.Public().(ed25519.PublicKey)
	} else {
		var err error
		pub, priv, err = ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return nil, fmt.Errorf("generate JWT signing key: %w", err)
		}
	}

	return &JWTManager{privateKey: priv, publicKey: pub, store: s}, nil
}

// IssueTokens creates an access token (short-lived JWT) and a refresh token
// (opaque, stored in DB) for the given subject.
func (j *JWTManager) IssueTokens(subjectID string, subjectType string) (accessToken string, refreshToken string, expiresIn int, err error) {
	now := time.Now()

	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subjectID,
			Issuer:    issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(accessTokenTTL)),
		},
		Type: subjectType,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	accessToken, err = token.SignedString(j.privateKey)
	if err != nil {
		return "", "", 0, fmt.Errorf("sign access token: %w", err)
	}

	// Generate opaque refresh token
	rtBytes := make([]byte, 32)
	if _, err := rand.Read(rtBytes); err != nil {
		return "", "", 0, fmt.Errorf("generate refresh token: %w", err)
	}
	refreshToken = base64.URLEncoding.EncodeToString(rtBytes)

	if err := j.store.StoreRefreshToken(refreshToken, subjectID, now.Add(refreshTokenTTL)); err != nil {
		return "", "", 0, fmt.Errorf("store refresh token: %w", err)
	}

	return accessToken, refreshToken, int(accessTokenTTL.Seconds()), nil
}

// ValidateAccessToken parses and validates a JWT access token.
// Returns the claims on success.
func (j *JWTManager) ValidateAccessToken(tokenStr string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodEd25519); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return j.publicKey, nil
	})
	if err != nil {
		return nil, fmt.Errorf("parse token: %w", err)
	}

	claims, ok := token.Claims.(*Claims)
	if !ok || !token.Valid {
		return nil, fmt.Errorf("invalid token claims")
	}
	return claims, nil
}

// RefreshAccessToken validates a refresh token and issues a new access token.
func (j *JWTManager) RefreshAccessToken(refreshToken string) (string, int, error) {
	subjectID, err := j.store.ValidateRefreshToken(refreshToken)
	if err != nil {
		return "", 0, fmt.Errorf("invalid refresh token: %w", err)
	}

	// Determine subject type by checking if it's a machine or device
	var subjectType string
	if _, err := j.store.GetMachine(subjectID); err == nil {
		subjectType = "machine"
	} else {
		subjectType = "device"
	}

	now := time.Now()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   subjectID,
			Issuer:    issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(accessTokenTTL)),
		},
		Type: subjectType,
	}

	token := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	accessToken, err := token.SignedString(j.privateKey)
	if err != nil {
		return "", 0, fmt.Errorf("sign access token: %w", err)
	}

	return accessToken, int(accessTokenTTL.Seconds()), nil
}

// GetStore returns the store (for use by RefreshAccessToken's type detection).
func (j *JWTManager) GetStore() store.Store {
	return j.store
}

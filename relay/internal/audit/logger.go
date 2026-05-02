// Package audit provides structured audit event logging for the relay.
package audit

import (
	"database/sql"
	"encoding/json"
	"log"
)

// Event types.
const (
	EventConnect    = "connect"
	EventDisconnect = "disconnect"
	EventPair       = "pair"
	EventUnpair     = "unpair"
	EventAuthFail   = "auth_fail"
	EventRegister   = "register"
)

// Logger writes audit events to the SQLite audit_log table.
type Logger struct {
	db *sql.DB
}

// New creates a new audit logger backed by the given database.
func New(db *sql.DB) *Logger {
	return &Logger{db: db}
}

// Log writes an audit event. Metadata is optional key-value pairs (serialized as JSON).
func (l *Logger) Log(event, machineID, deviceID, clientIP string, metadata map[string]string) {
	var metaJSON sql.NullString
	if len(metadata) > 0 {
		b, err := json.Marshal(metadata)
		if err == nil {
			metaJSON = sql.NullString{String: string(b), Valid: true}
		}
	}

	_, err := l.db.Exec(
		`INSERT INTO audit_log (event, machine_id, device_id, client_ip, metadata) VALUES (?, ?, ?, ?, ?)`,
		event, nullStr(machineID), nullStr(deviceID), nullStr(clientIP), metaJSON,
	)
	if err != nil {
		log.Printf("[audit] Failed to write event %q: %v", event, err)
	}
}

func nullStr(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

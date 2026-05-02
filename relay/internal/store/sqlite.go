package store

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound      = errors.New("not found")
	ErrAlreadyExists = errors.New("already exists")
	ErrExpired       = errors.New("expired")
	ErrMaxAttempts   = errors.New("max attempts exceeded")
)

// SQLiteStore implements Store using a local SQLite database.
type SQLiteStore struct {
	db *sql.DB
}

// NewSQLiteStore opens (or creates) a SQLite database at the given path.
func NewSQLiteStore(dbPath string) (*SQLiteStore, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}

	// WAL mode for concurrent reads during writes
	if _, err := db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		db.Close()
		return nil, fmt.Errorf("set WAL mode: %w", err)
	}
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable foreign keys: %w", err)
	}

	s := &SQLiteStore{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *SQLiteStore) migrate() error {
	schema := `
	CREATE TABLE IF NOT EXISTS machines (
		machine_id     TEXT PRIMARY KEY,
		public_key     TEXT NOT NULL,
		encryption_key TEXT NOT NULL DEFAULT '',
		display_name   TEXT NOT NULL DEFAULT '',
		registered_at  TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen      TEXT NOT NULL DEFAULT (datetime('now'))
	);

	CREATE TABLE IF NOT EXISTS devices (
		device_id      TEXT PRIMARY KEY,
		public_key     TEXT NOT NULL,
		encryption_key TEXT NOT NULL DEFAULT '',
		display_name   TEXT NOT NULL DEFAULT '',
		platform       TEXT NOT NULL DEFAULT 'web',
		machine_id     TEXT NOT NULL REFERENCES machines(machine_id),
		paired_at      TEXT NOT NULL DEFAULT (datetime('now')),
		last_seen      TEXT NOT NULL DEFAULT (datetime('now')),
		revoked        INTEGER NOT NULL DEFAULT 0
	);

	CREATE INDEX IF NOT EXISTS idx_devices_machine ON devices(machine_id) WHERE revoked = 0;

	CREATE TABLE IF NOT EXISTS pairing_requests (
		id                     TEXT PRIMARY KEY,
		machine_id             TEXT NOT NULL REFERENCES machines(machine_id),
		code_hash              TEXT NOT NULL,
		machine_encryption_key TEXT NOT NULL DEFAULT '',
		expires_at             TEXT NOT NULL,
		attempts               INTEGER NOT NULL DEFAULT 0,
		completed              INTEGER NOT NULL DEFAULT 0
	);

	CREATE INDEX IF NOT EXISTS idx_pairing_machine ON pairing_requests(machine_id) WHERE completed = 0;

	CREATE TABLE IF NOT EXISTS refresh_tokens (
		token      TEXT PRIMARY KEY,
		subject_id TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		revoked    INTEGER NOT NULL DEFAULT 0
	);

	CREATE TABLE IF NOT EXISTS challenges (
		subject_id TEXT PRIMARY KEY,
		challenge  TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS audit_log (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
		event      TEXT NOT NULL,
		machine_id TEXT,
		device_id  TEXT,
		client_ip  TEXT,
		metadata   TEXT
	);

	CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
	`
	_, err := s.db.Exec(schema)
	return err
}

// --- Machines ---

func (s *SQLiteStore) CreateMachine(m Machine) error {
	_, err := s.db.Exec(
		`INSERT INTO machines (machine_id, public_key, encryption_key, display_name) VALUES (?, ?, ?, ?)`,
		m.MachineID, m.PublicKey, m.EncryptionKey, m.DisplayName,
	)
	if err != nil {
		return fmt.Errorf("create machine: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetMachine(machineID string) (*Machine, error) {
	row := s.db.QueryRow(
		`SELECT machine_id, public_key, encryption_key, display_name, registered_at, last_seen FROM machines WHERE machine_id = ?`,
		machineID,
	)
	var m Machine
	var regAt, lastSeen string
	err := row.Scan(&m.MachineID, &m.PublicKey, &m.EncryptionKey, &m.DisplayName, &regAt, &lastSeen)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get machine: %w", err)
	}
	m.RegisteredAt, _ = time.Parse("2006-01-02 15:04:05", regAt)
	m.LastSeen, _ = time.Parse("2006-01-02 15:04:05", lastSeen)
	return &m, nil
}

func (s *SQLiteStore) TouchMachine(machineID string) error {
	_, err := s.db.Exec(`UPDATE machines SET last_seen = datetime('now') WHERE machine_id = ?`, machineID)
	return err
}

// --- Devices ---

func (s *SQLiteStore) CreateDevice(d Device) error {
	_, err := s.db.Exec(
		`INSERT INTO devices (device_id, public_key, encryption_key, display_name, platform, machine_id) VALUES (?, ?, ?, ?, ?, ?)`,
		d.DeviceID, d.PublicKey, d.EncryptionKey, d.DisplayName, d.Platform, d.MachineID,
	)
	if err != nil {
		return fmt.Errorf("create device: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetDevice(deviceID string) (*Device, error) {
	row := s.db.QueryRow(
		`SELECT device_id, public_key, encryption_key, display_name, platform, machine_id, paired_at, last_seen, revoked
		 FROM devices WHERE device_id = ?`,
		deviceID,
	)
	var d Device
	var pairedAt, lastSeen string
	var revoked int
	err := row.Scan(&d.DeviceID, &d.PublicKey, &d.EncryptionKey, &d.DisplayName, &d.Platform, &d.MachineID, &pairedAt, &lastSeen, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get device: %w", err)
	}
	d.PairedAt, _ = time.Parse("2006-01-02 15:04:05", pairedAt)
	d.LastSeen, _ = time.Parse("2006-01-02 15:04:05", lastSeen)
	d.Revoked = revoked != 0
	return &d, nil
}

func (s *SQLiteStore) ListDevicesForMachine(machineID string) ([]Device, error) {
	rows, err := s.db.Query(
		`SELECT device_id, public_key, encryption_key, display_name, platform, machine_id, paired_at, last_seen, revoked
		 FROM devices WHERE machine_id = ? AND revoked = 0 ORDER BY paired_at DESC`,
		machineID,
	)
	if err != nil {
		return nil, fmt.Errorf("list devices: %w", err)
	}
	defer rows.Close()

	var devices []Device
	for rows.Next() {
		var d Device
		var pairedAt, lastSeen string
		var revoked int
		if err := rows.Scan(&d.DeviceID, &d.PublicKey, &d.EncryptionKey, &d.DisplayName, &d.Platform, &d.MachineID, &pairedAt, &lastSeen, &revoked); err != nil {
			return nil, fmt.Errorf("scan device: %w", err)
		}
		d.PairedAt, _ = time.Parse("2006-01-02 15:04:05", pairedAt)
		d.LastSeen, _ = time.Parse("2006-01-02 15:04:05", lastSeen)
		d.Revoked = revoked != 0
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

func (s *SQLiteStore) RevokeDevice(deviceID string) error {
	res, err := s.db.Exec(`UPDATE devices SET revoked = 1 WHERE device_id = ?`, deviceID)
	if err != nil {
		return fmt.Errorf("revoke device: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *SQLiteStore) TouchDevice(deviceID string) error {
	_, err := s.db.Exec(`UPDATE devices SET last_seen = datetime('now') WHERE device_id = ?`, deviceID)
	return err
}

// --- Pairing ---

func (s *SQLiteStore) CreatePairingRequest(p PairingRequest) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO pairing_requests (id, machine_id, code_hash, machine_encryption_key, expires_at) VALUES (?, ?, ?, ?, ?)`,
		p.ID, p.MachineID, p.CodeHash, p.MachineEncryptionKey, p.ExpiresAt.UTC().Format("2006-01-02 15:04:05"),
	)
	return err
}

func (s *SQLiteStore) GetPairingRequestByMachine(machineID string) (*PairingRequest, error) {
	row := s.db.QueryRow(
		`SELECT id, machine_id, code_hash, machine_encryption_key, expires_at, attempts, completed
		 FROM pairing_requests WHERE machine_id = ? AND completed = 0 ORDER BY expires_at DESC LIMIT 1`,
		machineID,
	)
	var p PairingRequest
	var expiresAt string
	var completed int
	err := row.Scan(&p.ID, &p.MachineID, &p.CodeHash, &p.MachineEncryptionKey, &expiresAt, &p.Attempts, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get pairing request: %w", err)
	}
	p.ExpiresAt, _ = time.Parse("2006-01-02 15:04:05", expiresAt)
	p.Completed = completed != 0
	return &p, nil
}

func (s *SQLiteStore) IncrementPairingAttempts(id string) error {
	_, err := s.db.Exec(`UPDATE pairing_requests SET attempts = attempts + 1 WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) CompletePairingRequest(id string) error {
	_, err := s.db.Exec(`UPDATE pairing_requests SET completed = 1 WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) CleanExpiredPairings() error {
	_, err := s.db.Exec(`DELETE FROM pairing_requests WHERE expires_at < datetime('now')`)
	return err
}

// --- Refresh tokens ---

func (s *SQLiteStore) StoreRefreshToken(token string, subjectID string, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO refresh_tokens (token, subject_id, expires_at) VALUES (?, ?, ?)`,
		token, subjectID, expiresAt.UTC().Format("2006-01-02 15:04:05"),
	)
	return err
}

func (s *SQLiteStore) ValidateRefreshToken(token string) (string, error) {
	row := s.db.QueryRow(
		`SELECT subject_id, expires_at, revoked FROM refresh_tokens WHERE token = ?`, token,
	)
	var subjectID, expiresAt string
	var revoked int
	err := row.Scan(&subjectID, &expiresAt, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if revoked != 0 {
		return "", ErrNotFound
	}
	exp, _ := time.Parse("2006-01-02 15:04:05", expiresAt)
	if time.Now().UTC().After(exp) {
		return "", ErrExpired
	}
	return subjectID, nil
}

func (s *SQLiteStore) RevokeRefreshToken(token string) error {
	_, err := s.db.Exec(`UPDATE refresh_tokens SET revoked = 1 WHERE token = ?`, token)
	return err
}

// --- Challenges ---

func (s *SQLiteStore) StoreChallenge(id string, challenge string, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT OR REPLACE INTO challenges (subject_id, challenge, expires_at) VALUES (?, ?, ?)`,
		id, challenge, expiresAt.UTC().Format("2006-01-02 15:04:05"),
	)
	return err
}

func (s *SQLiteStore) ConsumeChallenge(id string) (string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	row := tx.QueryRow(`SELECT challenge, expires_at FROM challenges WHERE subject_id = ?`, id)
	var challenge, expiresAt string
	if err := row.Scan(&challenge, &expiresAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", ErrNotFound
		}
		return "", err
	}

	exp, _ := time.Parse("2006-01-02 15:04:05", expiresAt)
	if time.Now().UTC().After(exp) {
		tx.Exec(`DELETE FROM challenges WHERE subject_id = ?`, id)
		tx.Commit()
		return "", ErrExpired
	}

	tx.Exec(`DELETE FROM challenges WHERE subject_id = ?`, id)
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return challenge, nil
}

// --- Lifecycle ---

func (s *SQLiteStore) Close() error {
	return s.db.Close()
}

// DB exposes the underlying sql.DB for the audit logger.
func (s *SQLiteStore) DB() *sql.DB {
	return s.db
}

/**
 * Key Manager — generates, stores, and loads cryptographic keys for the relay.
 *
 * Ed25519 keypair:  Used for authentication (sign challenges to prove identity)
 * X25519 keypair:   Used for E2EE key agreement (derive shared secrets with paired devices)
 *
 * Keys are encrypted at rest using Electron's safeStorage (DPAPI on Windows,
 * Keychain on macOS, libsecret on Linux).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { safeStorage } from 'electron';

// safeStorage encrypts keys at rest using the OS credential store (DPAPI on
// Windows, Keychain on macOS, libsecret on Linux). It is accessed via a getter
// so call sites read through a single point.
function getSafeStorage(): typeof safeStorage {
  return safeStorage;
}

const KEYS_DIR = path.join(homedir(), '.agentplex', 'keys');
const MACHINE_SIGN_KEY_PATH = path.join(KEYS_DIR, 'machine-sign.enc');
const MACHINE_ENC_KEY_PATH = path.join(KEYS_DIR, 'machine-enc.enc');
const MACHINE_ID_PATH = path.join(KEYS_DIR, 'machine-id');
const PAIRED_DEVICES_PATH = path.join(homedir(), '.agentplex', 'paired-devices.json');
const PAIRING_SECRETS_PATH = path.join(KEYS_DIR, 'pairing-secrets.enc');

/**
 * By default we refuse to persist relay private keys unless the OS credential
 * store (safeStorage) can encrypt them at rest. Setting this env var to '1'
 * permits an INSECURE plaintext fallback — only for development on platforms
 * without a working keyring.
 */
const ALLOW_PLAINTEXT_KEYS = process.env.AGENTPLEX_ALLOW_PLAINTEXT_KEYS === '1';

/** Marker prefix identifying an explicitly-permitted plaintext key file. */
const PLAINTEXT_PREFIX = 'AGENTPLEX_PLAINTEXT_V1:';

// ── Types ───────────────────────────────────────────────────────────────────

export interface KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export interface PairedDevice {
  deviceId: string;
  encryptionKey: string; // X25519 public key, base64
  name: string;
  platform: string;
  pairedAt: string;
}

// ── Machine ID ──────────────────────────────────────────────────────────────

/** Get or create a stable machine identifier. */
export function getMachineId(): string {
  fs.mkdirSync(KEYS_DIR, { recursive: true });

  try {
    return fs.readFileSync(MACHINE_ID_PATH, 'utf-8').trim();
  } catch {
    // Generate a new machine ID
    const id = 'machine-' + crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(MACHINE_ID_PATH, id, 'utf-8');
    return id;
  }
}

// ── Key Generation & Storage ────────────────────────────────────────────────

/** Generate an Ed25519 keypair for authentication (signing). */
function generateSigningKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** Generate an X25519 keypair for E2EE key agreement. */
function generateEncryptionKeyPair(): KeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }),
  };
}

/** Encrypt and write a key to disk using safeStorage. */
function storeKey(filePath: string, keyData: Buffer) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const safe = getSafeStorage();
  if (safe.isEncryptionAvailable()) {
    const encrypted = safe.encryptString(keyData.toString('base64'));
    fs.writeFileSync(filePath, encrypted, { mode: 0o600 });
    return;
  }
  if (ALLOW_PLAINTEXT_KEYS) {
    console.warn('[key-manager] safeStorage unavailable — storing key UNENCRYPTED (AGENTPLEX_ALLOW_PLAINTEXT_KEYS=1). This is insecure.');
    fs.writeFileSync(filePath, PLAINTEXT_PREFIX + keyData.toString('base64'), { encoding: 'utf-8', mode: 0o600 });
    return;
  }
  throw new Error(
    'OS key encryption (safeStorage) is unavailable; refusing to store relay private keys in plaintext. ' +
    'Set AGENTPLEX_ALLOW_PLAINTEXT_KEYS=1 to override (insecure, development only).',
  );
}

/** Read and decrypt a key from disk. */
function loadKey(filePath: string): Buffer | null {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch {
    return null;
  }

  // Explicitly-marked plaintext key (only written under the override flag).
  const prefix = Buffer.from(PLAINTEXT_PREFIX, 'utf-8');
  if (raw.length >= prefix.length && raw.subarray(0, prefix.length).equals(prefix)) {
    return Buffer.from(raw.subarray(prefix.length).toString('utf-8'), 'base64');
  }

  // Otherwise the file must be a safeStorage-encrypted blob.
  const safe = getSafeStorage();
  if (!safe.isEncryptionAvailable()) {
    console.warn('[key-manager] Cannot decrypt stored relay key — safeStorage is unavailable.');
    return null;
  }
  try {
    return Buffer.from(safe.decryptString(raw), 'base64');
  } catch {
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Load or generate the machine's Ed25519 signing keypair. */
export function getSigningKeyPair(): KeyPair {
  const existing = loadKey(MACHINE_SIGN_KEY_PATH);
  if (existing) {
    // Derive public key from stored private key
    const privateKeyObj = crypto.createPrivateKey({ key: existing, format: 'der', type: 'pkcs8' });
    const publicKeyObj = crypto.createPublicKey(privateKeyObj);
    return {
      publicKey: publicKeyObj.export({ type: 'spki', format: 'der' }),
      privateKey: existing,
    };
  }

  console.log('[key-manager] Generating new Ed25519 signing keypair');
  const kp = generateSigningKeyPair();
  storeKey(MACHINE_SIGN_KEY_PATH, kp.privateKey);
  return kp;
}

/** Load or generate the machine's X25519 encryption keypair. */
export function getEncryptionKeyPair(): KeyPair {
  const existing = loadKey(MACHINE_ENC_KEY_PATH);
  if (existing) {
    const privateKeyObj = crypto.createPrivateKey({ key: existing, format: 'der', type: 'pkcs8' });
    const publicKeyObj = crypto.createPublicKey(privateKeyObj);
    return {
      publicKey: publicKeyObj.export({ type: 'spki', format: 'der' }),
      privateKey: existing,
    };
  }

  console.log('[key-manager] Generating new X25519 encryption keypair');
  const kp = generateEncryptionKeyPair();
  storeKey(MACHINE_ENC_KEY_PATH, kp.privateKey);
  return kp;
}

/** Get the Ed25519 public key as a base64 string (for relay registration). */
export function getSigningPublicKeyBase64(): string {
  const kp = getSigningKeyPair();
  // Extract the raw 32-byte public key from the SPKI-encoded DER
  // Ed25519 SPKI is: 30 2a 30 05 06 03 2b 65 70 03 21 00 <32 bytes>
  const raw = kp.publicKey.subarray(-32);
  return raw.toString('base64');
}

/** Get the X25519 public key as a base64 string (for E2EE pairing). */
export function getEncryptionPublicKeyBase64(): string {
  const kp = getEncryptionKeyPair();
  // X25519 SPKI is: 30 2a 30 05 06 03 2b 65 6e 03 21 00 <32 bytes>
  const raw = kp.publicKey.subarray(-32);
  return raw.toString('base64');
}

/** Sign data with the machine's Ed25519 private key. Returns base64 signature. */
export function sign(data: Buffer): string {
  const kp = getSigningKeyPair();
  const privateKeyObj = crypto.createPrivateKey({ key: kp.privateKey, format: 'der', type: 'pkcs8' });
  const signature = crypto.sign(null, data, privateKeyObj);
  return signature.toString('base64');
}

// ── Paired Devices ──────────────────────────────────────────────────────────

/** Load the list of paired devices from disk. */
export function loadPairedDevices(): PairedDevice[] {
  try {
    const raw = fs.readFileSync(PAIRED_DEVICES_PATH, 'utf-8');
    return JSON.parse(raw) as PairedDevice[];
  } catch {
    return [];
  }
}

/** Save the list of paired devices to disk. */
export function savePairedDevices(devices: PairedDevice[]) {
  const dir = path.dirname(PAIRED_DEVICES_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PAIRED_DEVICES_PATH, JSON.stringify(devices, null, 2), 'utf-8');
}

/** Add a newly paired device. */
export function addPairedDevice(device: PairedDevice) {
  const devices = loadPairedDevices();
  // Replace if same deviceId exists
  const idx = devices.findIndex(d => d.deviceId === device.deviceId);
  if (idx >= 0) {
    devices[idx] = device;
  } else {
    devices.push(device);
  }
  savePairedDevices(devices);
}

/** Remove a paired device by ID. */
export function removePairedDevice(deviceId: string) {
  const devices = loadPairedDevices().filter(d => d.deviceId !== deviceId);
  savePairedDevices(devices);
}

/** Get a paired device by ID. */
export function getPairedDevice(deviceId: string): PairedDevice | undefined {
  return loadPairedDevices().find(d => d.deviceId === deviceId);
}

// ── Pairing Codes ───────────────────────────────────────────────────────────

/** Generate a 128-bit pairing secret. Unlike a short numeric code, this cannot
 * be recovered from the hash stored by an untrusted relay. */
export function generatePairingCode(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** SHA-256 hash a pairing code (for sending to the relay). */
export function hashPairingCode(code: string): string {
  return crypto.createHash('sha256').update(normalizePairingCode(code), 'hex').digest('hex');
}

function normalizePairingCode(code: string): string {
  return code.replace(/-/g, '').trim().toLowerCase();
}

/** Authenticate pairing key material with the high-entropy out-of-band secret. */
export function createPairingProof(code: string, ...parts: string[]): string {
  const secret = Buffer.from(normalizePairingCode(code), 'hex');
  if (secret.length !== 16) throw new Error('Invalid pairing secret');
  return crypto.createHmac('sha256', secret)
    .update(parts.join('\0'), 'utf-8')
    .digest('base64');
}

/** Constant-time validation for a pairing transcript proof. */
export function verifyPairingProof(code: string, proof: string, ...parts: string[]): boolean {
  try {
    const actual = Buffer.from(proof, 'base64');
    const expected = Buffer.from(createPairingProof(code, ...parts), 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function loadPairingSecrets(): Record<string, string> {
  const raw = loadKey(PAIRING_SECRETS_PATH);
  if (!raw) return {};
  try {
    return JSON.parse(raw.toString('utf-8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Retain in-flight secrets encrypted at rest so an offline completion can be
 * authenticated when the desktop reconnects. */
export function rememberPairingSecret(codeHash: string, code: string) {
  const secrets = loadPairingSecrets();
  secrets[codeHash] = normalizePairingCode(code);
  storeKey(PAIRING_SECRETS_PATH, Buffer.from(JSON.stringify(secrets), 'utf-8'));
}

export function getPairingSecret(codeHash: string): string | undefined {
  return loadPairingSecrets()[codeHash];
}

export function forgetPairingSecret(codeHash: string) {
  const secrets = loadPairingSecrets();
  delete secrets[codeHash];
  storeKey(PAIRING_SECRETS_PATH, Buffer.from(JSON.stringify(secrets), 'utf-8'));
}

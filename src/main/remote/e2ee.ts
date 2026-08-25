/**
 * E2EE — End-to-end encryption using X25519 key agreement + ChaCha20-Poly1305.
 *
 * The relay server never sees plaintext. Only the two paired endpoints
 * (AgentPlex desktop + remote device) can decrypt messages.
 *
 * Flow:
 *   1. During pairing, both sides exchange X25519 public keys
 *   2. Each side derives the same shared secret: X25519(myPrivate, theirPublic)
 *   3. A session key is derived via HKDF-SHA256(sharedSecret, salt, info)
 *   4. Messages are encrypted with ChaCha20-Poly1305 using the session key
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { getEncryptionKeyPair } from './key-manager';

const HKDF_SALT_PREFIX = 'agentplex-e2ee-v1';
const NONCE_LENGTH = 12;    // 96-bit nonce for ChaCha20-Poly1305
const TAG_LENGTH = 16;      // Poly1305 auth tag
const OUTBOUND_EPOCH = crypto.randomBytes(16).toString('base64url');
const REPLAY_STATE_PATH = path.join(homedir(), '.agentplex', 'remote-replay-state.json');

// Cache derived session keys: deviceId → Buffer
const sessionKeyCache = new Map<string, Buffer>();
const sendCounters = new Map<string, number>();

interface ReceiveReplayState {
  epoch: string;
  lastSequence: number;
  previousEpochs: string[];
}

let receiveReplayState: Record<string, ReceiveReplayState> | null = null;
let replaySavePending = false;
let replaySaveDirty = false;

function loadReceiveReplayState(): Record<string, ReceiveReplayState> {
  if (receiveReplayState) return receiveReplayState;
  try {
    const parsed = JSON.parse(fs.readFileSync(REPLAY_STATE_PATH, 'utf-8'));
    receiveReplayState = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    receiveReplayState = {};
  }
  return receiveReplayState!;
}

function scheduleReceiveReplayStateSave() {
  replaySaveDirty = true;
  if (replaySavePending) return;
  replaySavePending = true;
  setTimeout(async () => {
    while (replaySaveDirty) {
      replaySaveDirty = false;
      try {
        const state = loadReceiveReplayState();
        await fs.promises.mkdir(path.dirname(REPLAY_STATE_PATH), { recursive: true });
        const tempPath = `${REPLAY_STATE_PATH}.tmp`;
        await fs.promises.writeFile(tempPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
        await fs.promises.rename(tempPath, REPLAY_STATE_PATH);
      } catch (err) {
        console.warn(`[e2ee] Failed to persist replay state: ${(err as Error).message}`);
      }
    }
    replaySavePending = false;
  }, 25);
}

function nextSequence(machineId: string, deviceId: string): number {
  const key = `${machineId}:${deviceId}`;
  const next = (sendCounters.get(key) ?? 0) + 1;
  sendCounters.set(key, next);
  return next;
}

function acceptDeviceSequence(
  machineId: string,
  deviceId: string,
  epoch: string,
  sequence: number,
): boolean {
  const state = loadReceiveReplayState();
  const key = `${machineId}:${deviceId}`;
  const stored = state[key];
  const current = stored &&
    typeof stored.epoch === 'string' &&
    Number.isSafeInteger(stored.lastSequence)
    ? {
        epoch: stored.epoch,
        lastSequence: stored.lastSequence,
        previousEpochs: Array.isArray(stored.previousEpochs)
          ? stored.previousEpochs.filter(value => typeof value === 'string')
          : [],
      }
    : undefined;
  if (current) state[key] = current;
  if (!current) {
    state[key] = { epoch, lastSequence: sequence, previousEpochs: [] };
  } else if (current.epoch === epoch) {
    if (sequence <= current.lastSequence) return false;
    current.lastSequence = sequence;
  } else {
    if (current.previousEpochs.includes(epoch)) return false;
    current.previousEpochs = [current.epoch, ...current.previousEpochs].slice(0, 8);
    current.epoch = epoch;
    current.lastSequence = sequence;
  }
  scheduleReceiveReplayStateSave();
  return true;
}

// ── Key Agreement ───────────────────────────────────────────────────────────

/**
 * Derive a shared secret using X25519 key agreement.
 * sharedSecret = X25519(ourPrivateKey, theirPublicKey)
 */
function deriveSharedSecret(theirPublicKeyRaw: Buffer): Buffer {
  const kp = getEncryptionKeyPair();

  const ourPrivateKey = crypto.createPrivateKey({
    key: kp.privateKey,
    format: 'der',
    type: 'pkcs8',
  });

  // Wrap the raw 32-byte X25519 public key in SPKI DER format
  // X25519 SPKI header: 30 2a 30 05 06 03 2b 65 6e 03 21 00
  const spkiHeader = Buffer.from('302a300506032b656e032100', 'hex');
  const theirPublicKeyDer = Buffer.concat([spkiHeader, theirPublicKeyRaw]);

  const theirPublicKey = crypto.createPublicKey({
    key: theirPublicKeyDer,
    format: 'der',
    type: 'spki',
  });

  return crypto.diffieHellman({
    privateKey: ourPrivateKey,
    publicKey: theirPublicKey,
  });
}

/**
 * Derive a session key from the shared secret using HKDF-SHA256.
 */
function deriveSessionKey(sharedSecret: Buffer, machineId: string, deviceId: string): Buffer {
  const salt = crypto.createHash('sha256')
    .update(`${machineId}:${deviceId}`)
    .digest();

  return Buffer.from(
    crypto.hkdfSync('sha256', sharedSecret, salt, HKDF_SALT_PREFIX, 32)
  );
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get or derive the session key for a paired device.
 * Caches the result so key derivation only happens once per device.
 */
export function getSessionKey(machineId: string, deviceId: string, theirEncryptionKeyB64: string): Buffer {
  const cacheKey = `${machineId}:${deviceId}`;
  const cached = sessionKeyCache.get(cacheKey);
  if (cached) return cached;

  const theirPublicKey = Buffer.from(theirEncryptionKeyB64, 'base64');
  const sharedSecret = deriveSharedSecret(theirPublicKey);
  const sessionKey = deriveSessionKey(sharedSecret, machineId, deviceId);

  sessionKeyCache.set(cacheKey, sessionKey);
  return sessionKey;
}

/** Clear the session key cache (e.g., on device revocation). */
export function clearSessionKey(deviceId: string) {
  for (const key of sessionKeyCache.keys()) {
    if (key.endsWith(`:${deviceId}`)) {
      sessionKeyCache.delete(key);
    }
  }
}

/** Clear all cached session keys. */
export function clearAllSessionKeys() {
  sessionKeyCache.clear();
}

// ── Envelope ────────────────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  type: 'envelope';
  to: string;
  epoch: string;
  seq: number;
  nonce: string; // base64
  ct: string;    // base64 (ciphertext + poly1305 tag)
}

/**
 * Encrypt a plaintext message into an E2EE envelope.
 *
 * @param sessionKey - 32-byte derived key for this machine↔device pair
 * @param machineId - this machine's ID (used as AAD)
 * @param deviceId - target device ID (used as AAD + routing)
 * @param plaintext - JSON string to encrypt
 */
export function encrypt(sessionKey: Buffer, machineId: string, deviceId: string, plaintext: string): EncryptedEnvelope {
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const seq = nextSequence(machineId, deviceId);
  const aad = Buffer.from(`${machineId}:${deviceId}:machine:${OUTBOUND_EPOCH}:${seq}`, 'utf-8');

  const cipher = crypto.createCipheriv('chacha20-poly1305', sessionKey, nonce, {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(plaintext, 'utf-8') });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    type: 'envelope',
    to: deviceId,
    epoch: OUTBOUND_EPOCH,
    seq,
    nonce: nonce.toString('base64'),
    ct: Buffer.concat([encrypted, tag]).toString('base64'),
  };
}

/**
 * Decrypt an E2EE envelope back to plaintext.
 *
 * @param sessionKey - 32-byte derived key for this machine↔device pair
 * @param machineId - this machine's ID (used as AAD)
 * @param deviceId - source device ID (used as AAD)
 * @param envelope - the encrypted envelope
 * @returns decrypted plaintext string, or null if decryption fails
 */
export function decrypt(
  sessionKey: Buffer,
  machineId: string,
  deviceId: string,
  envelope: { epoch: string; seq: number; nonce: string; ct: string },
): string | null {
  try {
    if (
      typeof envelope.epoch !== 'string' ||
      !envelope.epoch ||
      !Number.isSafeInteger(envelope.seq) ||
      envelope.seq <= 0
    ) return null;
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const ctWithTag = Buffer.from(envelope.ct, 'base64');

    if (nonce.length !== NONCE_LENGTH) return null;
    if (ctWithTag.length < TAG_LENGTH) return null;

    const ciphertext = ctWithTag.subarray(0, -TAG_LENGTH);
    const tag = ctWithTag.subarray(-TAG_LENGTH);
    const aad = Buffer.from(
      `${machineId}:${deviceId}:device:${envelope.epoch}:${envelope.seq}`,
      'utf-8',
    );

    const decipher = crypto.createDecipheriv('chacha20-poly1305', sessionKey, nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    if (!acceptDeviceSequence(machineId, deviceId, envelope.epoch, envelope.seq)) {
      return null;
    }
    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

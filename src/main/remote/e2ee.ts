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
import { getEncryptionKeyPair } from './key-manager';

const HKDF_SALT_PREFIX = 'agentplex-e2ee-v1';
const NONCE_LENGTH = 12;    // 96-bit nonce for ChaCha20-Poly1305
const TAG_LENGTH = 16;      // Poly1305 auth tag

// Cache derived session keys: deviceId → Buffer
const sessionKeyCache = new Map<string, Buffer>();

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
  const aad = Buffer.from(`${machineId}:${deviceId}`, 'utf-8');

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
export function decrypt(sessionKey: Buffer, machineId: string, deviceId: string, envelope: { nonce: string; ct: string }): string | null {
  try {
    const nonce = Buffer.from(envelope.nonce, 'base64');
    const ctWithTag = Buffer.from(envelope.ct, 'base64');

    if (nonce.length !== NONCE_LENGTH) return null;
    if (ctWithTag.length < TAG_LENGTH) return null;

    const ciphertext = ctWithTag.subarray(0, -TAG_LENGTH);
    const tag = ctWithTag.subarray(-TAG_LENGTH);
    const aad = Buffer.from(`${machineId}:${deviceId}`, 'utf-8');

    const decipher = crypto.createDecipheriv('chacha20-poly1305', sessionKey, nonce, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(aad, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  } catch {
    return null;
  }
}

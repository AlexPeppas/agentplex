/**
 * E2EE encryption using X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
 * Mirrors the desktop-side e2ee.ts exactly.
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { getEncPrivKey } from './keys';

const HKDF_INFO = new TextEncoder().encode('agentplex-e2ee-v1');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

// Cache: `${machineId}:${deviceId}` → session key
const sessionKeyCache = new Map<string, Uint8Array>();

// ── Key derivation ────────────────────────────────────────────────────────────

function deriveSessionKey(
  sharedSecret: Uint8Array,
  machineId: string,
  deviceId: string,
): Uint8Array {
  const salt = sha256(new TextEncoder().encode(`${machineId}:${deviceId}`));
  return hkdf(sha256, sharedSecret, salt, HKDF_INFO, 32);
}

export async function getSessionKey(
  machineId: string,
  deviceId: string,
  machineEncKeyB64: string,
): Promise<Uint8Array> {
  const cacheKey = `${machineId}:${deviceId}`;
  const cached = sessionKeyCache.get(cacheKey);
  if (cached) return cached;

  const ourPriv = await getEncPrivKey();
  const theirPub = Uint8Array.from(atob(machineEncKeyB64), c => c.charCodeAt(0));
  const sharedSecret = x25519.getSharedSecret(ourPriv, theirPub);
  const sessionKey = deriveSessionKey(sharedSecret, machineId, deviceId);

  sessionKeyCache.set(cacheKey, sessionKey);
  return sessionKey;
}

export function clearSessionKey(machineId: string, deviceId: string) {
  sessionKeyCache.delete(`${machineId}:${deviceId}`);
}

// ── Envelope ──────────────────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  type: 'envelope';
  to: string;
  nonce: string;
  ct: string;
}

export async function encryptEnvelope(
  sessionKey: Uint8Array,
  machineId: string,
  deviceId: string,
  toId: string,
  payload: object,
): Promise<EncryptedEnvelope> {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const nonce = randomBytes(NONCE_LENGTH);
  const aad = new TextEncoder().encode(`${machineId}:${deviceId}`);

  const cipher = chacha20poly1305(sessionKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext); // includes poly1305 tag appended

  return {
    type: 'envelope',
    to: toId,
    nonce: btoa(String.fromCharCode(...nonce)),
    ct: btoa(String.fromCharCode(...ciphertext)),
  };
}

export function decryptEnvelope(
  sessionKey: Uint8Array,
  machineId: string,
  deviceId: string,
  envelope: { nonce: string; ct: string },
): string | null {
  try {
    const nonce = Uint8Array.from(atob(envelope.nonce), c => c.charCodeAt(0));
    const ctWithTag = Uint8Array.from(atob(envelope.ct), c => c.charCodeAt(0));

    if (nonce.length !== NONCE_LENGTH) return null;
    if (ctWithTag.length < TAG_LENGTH) return null;

    const aad = new TextEncoder().encode(`${machineId}:${deviceId}`);
    const cipher = chacha20poly1305(sessionKey, nonce, aad);
    const plaintext = cipher.decrypt(ctWithTag); // verifies tag, throws on failure

    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

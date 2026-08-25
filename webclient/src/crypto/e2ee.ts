/**
 * E2EE encryption using X25519 + HKDF-SHA256 + ChaCha20-Poly1305.
 * Mirrors the desktop-side e2ee.ts exactly.
 */

import { x25519 } from '@noble/curves/ed25519';
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { getEncPrivKey } from './keys';

const HKDF_INFO = new TextEncoder().encode('agentplex-e2ee-v1');
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const OUTBOUND_STATE_PREFIX = 'agentplex-device-envelope-state:';

// Cache: `${machineId}:${deviceId}` → session key
const sessionKeyCache = new Map<string, Uint8Array>();
const receiveSequences = new Map<string, { epoch: string; sequence: number; previousEpochs: string[] }>();

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function nextEnvelopeState(machineId: string, deviceId: string): { epoch: string; seq: number } {
  const key = `${OUTBOUND_STATE_PREFIX}${machineId}:${deviceId}`;
  let epoch = '';
  let seq = 0;
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (
      parsed &&
      typeof parsed.epoch === 'string' &&
      Number.isSafeInteger(parsed.seq) &&
      parsed.seq >= 0
    ) {
      epoch = parsed.epoch;
      seq = parsed.seq;
    }
  } catch {
    // Generate a fresh epoch below.
  }
  if (!epoch) epoch = encodeBase64(randomBytes(16));
  seq += 1;
  localStorage.setItem(key, JSON.stringify({ epoch, seq }));
  return { epoch, seq };
}

function acceptMachineSequence(
  machineId: string,
  deviceId: string,
  epoch: string,
  sequence: number,
): boolean {
  const key = `${machineId}:${deviceId}`;
  const current = receiveSequences.get(key);
  if (!current) {
    receiveSequences.set(key, { epoch, sequence, previousEpochs: [] });
    return true;
  }
  if (current.epoch === epoch) {
    if (sequence <= current.sequence) return false;
    current.sequence = sequence;
    return true;
  }
  if (current.previousEpochs.includes(epoch)) return false;
  current.previousEpochs = [current.epoch, ...current.previousEpochs].slice(0, 8);
  current.epoch = epoch;
  current.sequence = sequence;
  return true;
}

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

function normalizePairingCode(code: string): string {
  return code.replace(/-/g, '').trim().toLowerCase();
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new Error('Invalid pairing code');
  return Uint8Array.from(hex.match(/.{2}/g)!, byte => Number.parseInt(byte, 16));
}

export function hashPairingCode(code: string): string {
  return Array.from(sha256(hexToBytes(normalizePairingCode(code))))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createPairingProof(code: string, ...parts: string[]): string {
  const secret = hexToBytes(normalizePairingCode(code));
  const message = new TextEncoder().encode(parts.join('\0'));
  return encodeBase64(hmac(sha256, secret, message));
}

export function verifyPairingProof(code: string, proof: string, ...parts: string[]): boolean {
  try {
    const expected = Uint8Array.from(atob(createPairingProof(code, ...parts)), c => c.charCodeAt(0));
    const actual = Uint8Array.from(atob(proof), c => c.charCodeAt(0));
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference |= actual[i] ^ expected[i];
    return difference === 0;
  } catch {
    return false;
  }
}

// ── Envelope ──────────────────────────────────────────────────────────────────

export interface EncryptedEnvelope {
  type: 'envelope';
  to: string;
  epoch: string;
  seq: number;
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
  const { epoch, seq } = nextEnvelopeState(machineId, deviceId);
  const aad = new TextEncoder().encode(`${machineId}:${deviceId}:device:${epoch}:${seq}`);

  const cipher = chacha20poly1305(sessionKey, nonce, aad);
  const ciphertext = cipher.encrypt(plaintext); // includes poly1305 tag appended

  return {
    type: 'envelope',
    to: toId,
    epoch,
    seq,
    nonce: encodeBase64(nonce),
    ct: encodeBase64(ciphertext),
  };
}

export function decryptEnvelope(
  sessionKey: Uint8Array,
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
    const nonce = Uint8Array.from(atob(envelope.nonce), c => c.charCodeAt(0));
    const ctWithTag = Uint8Array.from(atob(envelope.ct), c => c.charCodeAt(0));

    if (nonce.length !== NONCE_LENGTH) return null;
    if (ctWithTag.length < TAG_LENGTH) return null;

    const aad = new TextEncoder().encode(
      `${machineId}:${deviceId}:machine:${envelope.epoch}:${envelope.seq}`,
    );
    const cipher = chacha20poly1305(sessionKey, nonce, aad);
    const plaintext = cipher.decrypt(ctWithTag); // verifies tag, throws on failure

    if (!acceptMachineSequence(machineId, deviceId, envelope.epoch, envelope.seq)) {
      return null;
    }
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Cryptographic key management for the AgentPlex web client.
 *
 * - Ed25519 keypair: authenticate with the relay (sign challenges)
 * - X25519 keypair:  E2EE key agreement with the AgentPlex machine
 *
 * Both keypairs are generated once and stored in IndexedDB.
 * Keys are raw bytes (Uint8Array), compatible with @noble/curves.
 */

import { openDB, type IDBPDatabase } from 'idb';
import { ed25519, x25519 } from '@noble/curves/ed25519';

const DB_NAME = 'agentplex-keys';
const DB_VERSION = 1;
const STORE = 'keys';

let _db: IDBPDatabase | null = null;

async function getDB(): Promise<IDBPDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE);
    },
  });
  return _db;
}

async function loadOrGenerate(key: string, generate: () => Uint8Array): Promise<Uint8Array> {
  const db = await getDB();
  const existing = await db.get(STORE, key);
  if (existing instanceof Uint8Array && existing.length > 0) return existing;
  const fresh = generate();
  await db.put(STORE, fresh, key);
  return fresh;
}

// ── Ed25519 ──────────────────────────────────────────────────────────────────

export async function getSigningPrivKey(): Promise<Uint8Array> {
  return loadOrGenerate('ed25519-priv', () => ed25519.utils.randomPrivateKey());
}

export async function getSigningPubKey(): Promise<Uint8Array> {
  const priv = await getSigningPrivKey();
  return ed25519.getPublicKey(priv);
}

export async function getSigningPubKeyB64(): Promise<string> {
  const pub = await getSigningPubKey();
  return btoa(String.fromCharCode(...pub));
}

/** Sign a base64-encoded challenge from the relay. Returns base64 signature. */
export async function signChallenge(challengeB64: string): Promise<string> {
  const priv = await getSigningPrivKey();
  const challengeBytes = Uint8Array.from(atob(challengeB64), c => c.charCodeAt(0));
  const sig = ed25519.sign(challengeBytes, priv);
  return btoa(String.fromCharCode(...sig));
}

// ── X25519 ───────────────────────────────────────────────────────────────────

export async function getEncPrivKey(): Promise<Uint8Array> {
  return loadOrGenerate('x25519-priv', () => x25519.utils.randomPrivateKey());
}

export async function getEncPubKey(): Promise<Uint8Array> {
  const priv = await getEncPrivKey();
  return x25519.getPublicKey(priv);
}

export async function getEncPubKeyB64(): Promise<string> {
  const pub = await getEncPubKey();
  return btoa(String.fromCharCode(...pub));
}

// ── Device ID ─────────────────────────────────────────────────────────────────

export async function getDeviceId(): Promise<string | null> {
  const db = await getDB();
  return (await db.get(STORE, 'device-id')) as string | null;
}

export async function saveDeviceId(id: string): Promise<void> {
  const db = await getDB();
  await db.put(STORE, id, 'device-id');
}

// ── Refresh token ─────────────────────────────────────────────────────────────

export async function getRefreshToken(): Promise<string | null> {
  const db = await getDB();
  return (await db.get(STORE, 'refresh-token')) as string | null;
}

export async function saveRefreshToken(token: string): Promise<void> {
  const db = await getDB();
  await db.put(STORE, token, 'refresh-token');
}

// ── Clear all keys (unpair) ───────────────────────────────────────────────────

export async function clearAllKeys(): Promise<void> {
  const db = await getDB();
  await db.clear(STORE);
}

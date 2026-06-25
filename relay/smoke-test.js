// End-to-end smoke test of the relay auth handshake.
// Mirrors the desktop key formats: Ed25519 keys exported as SPKI DER, base64.
const crypto = require('crypto');

const BASE = process.env.RELAY_BASE || 'http://127.0.0.1:18080';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

(async () => {
  const machineId = 'machine-' + crypto.randomBytes(8).toString('hex');

  // Generate an Ed25519 keypair exactly like the desktop key-manager.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // The relay expects the RAW 32-byte key; SPKI DER ends with those 32 bytes
  // (desktop key-manager does the same subarray(-32)).
  const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  // Also an X25519 encryption pubkey (sent at registration).
  const enc = crypto.generateKeyPairSync('x25519');
  const encB64 = enc.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');

  // 1) Register machine
  const reg = await post('/register/machine', {
    machineId, publicKey: pubB64, encryptionKey: encB64, displayName: 'smoke-test',
  });
  console.log('register:', reg.status, JSON.stringify(reg.json));
  if (reg.status !== 201 && reg.status !== 200) throw new Error('register failed');

  // 2) Request challenge
  const ch = await post('/auth/challenge', { id: machineId });
  console.log('challenge:', ch.status, ch.json.challenge ? '(got challenge)' : JSON.stringify(ch.json));
  if (ch.status !== 200 || !ch.json.challenge) throw new Error('challenge failed');

  // 3) Sign the challenge (raw bytes) with Ed25519 — matches desktop sign()
  const challengeBytes = Buffer.from(ch.json.challenge, 'base64');
  const signature = crypto.sign(null, challengeBytes, privateKey).toString('base64');

  // 4) Exchange for tokens
  const tok = await post('/auth/token', { id: machineId, signature });
  console.log('token:', tok.status, tok.json.accessToken ? '(got JWT + refresh)' : JSON.stringify(tok.json));
  if (tok.status !== 200 || !tok.json.accessToken || !tok.json.refreshToken) throw new Error('token failed');

  // 5) Refresh the access token
  const ref = await post('/auth/refresh', { refreshToken: tok.json.refreshToken });
  console.log('refresh:', ref.status, ref.json.accessToken ? '(refreshed)' : JSON.stringify(ref.json));
  if (ref.status !== 200 || !ref.json.accessToken) throw new Error('refresh failed');

  // 6) Negative test: a bad signature must be rejected.
  const bad = await post('/auth/token', { id: machineId, signature: Buffer.from('nope').toString('base64') });
  console.log('bad-signature:', bad.status, '(expect 401)');
  if (bad.status !== 401) throw new Error('bad signature was NOT rejected — auth bypass!');

  console.log('\nSMOKE TEST PASSED — register → challenge → sign → token → refresh, bad-sig rejected.');
})().catch(e => { console.error('SMOKE TEST FAILED:', e.message); process.exit(1); });

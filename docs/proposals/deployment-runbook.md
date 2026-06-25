# AgentPlex Remote — Deployment Runbook

End-to-end steps to take the "AgentPlex on the web" feature live: deploy the
relay, host the web client, then pair from a browser. The relay is a **blind
pipe** — it never sees terminal data (E2EE between desktop and client).

See `docs/proposals/relay-architecture.md` for the full design.

## Components

| Component | What it is | Where it runs |
|---|---|---|
| Relay (Go) | Blind E2EE message router + pairing/JWT auth | Fly.io (behind Cloudflare) |
| Web client | React mirror of the desktop UI | Any static host (Cloudflare Pages / Vercel / Netlify) |
| Desktop | AgentPlex Electron app (the "machine") | The user's PC(s) — must be running |

## 1. Deploy the relay (Fly.io + Cloudflare)

```bash
cd relay

# One-time: create the app + persistent volume for the SQLite DB
fly launch --no-deploy --name agentplex-relay
fly volumes create relay_data --size 1 --region iad

# CRITICAL: persist the JWT signing key as a secret. Without this, every relay
# restart invalidates all issued tokens (machines/devices must re-auth).
fly secrets set JWT_SIGNING_KEY=$(openssl rand -hex 32)

fly deploy
fly status                 # confirm 1 machine running
curl https://agentplex-relay.fly.dev/health   # -> {"status":"ok",...}
```

### Cloudflare (DDoS + TLS, optional but recommended)

Point a proxied DNS record at the Fly app:

```
relay.agentplex.dev  CNAME  agentplex-relay.fly.dev   (Proxied / orange cloud)
```

All payload is E2EE, so Cloudflare only ever sees encrypted blobs. WebSocket
proxying works on the free tier (100s idle timeout; the client pings every 30s).

## 2. Host the web client (static site)

```bash
cd webclient
npm install
npm run build           # outputs dist/
# Deploy dist/ to any static host, e.g.:
#   npx wrangler pages deploy dist        (Cloudflare Pages)
#   vercel deploy --prod dist             (Vercel)
```

The relay URL is **entered at runtime** on the pairing screen, so no build-time
configuration is required. (Optionally pre-fill it by editing the default in
`webclient/src/components/PairingScreen.tsx`.)

## 3. Pair a machine (desktop → web)

On the desktop app:
1. Settings → **Remote access**.
2. Enter the Relay URL (e.g. `https://relay.agentplex.dev`) → **Connect**.
3. Copy the **Machine ID**.
4. Click **Generate code** (valid 5 minutes).

In the web client:
1. Open the hosted site → enter Relay URL, Machine ID, the 6-digit code, and a
   machine label → **Pair Device**.
2. The session graph appears, grouped under that machine.

Repeat steps 3–4 / 1–2 from a **second** machine (devbox, laptop) to pair it
too — the web client shows all paired machines and their sessions at once.

## 4. Verify the auth handshake (no Fly account needed)

`relay/smoke-test.js` exercises the full handshake against a locally-run relay —
register → challenge → Ed25519 sign → JWT → refresh, and asserts a bad signature
is rejected. Use it to validate a build before deploying:

```bash
cd relay
go build -o relay ./cmd/relay
LISTEN_ADDR=:18080 DB_PATH=/tmp/relay-smoke.db ./relay &
RELAY_BASE=http://127.0.0.1:18080 node smoke-test.js
```

## Environment variables (relay)

| Variable | Default | Notes |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | Listen address |
| `DB_PATH` | `./relay.db` | SQLite path (use the mounted volume on Fly: `/data/relay.db`) |
| `JWT_SIGNING_KEY` | auto-generated | 32-byte hex Ed25519 seed. **Set in production** — auto-generated keys are lost on restart. |

## Security notes

- Desktop relay private keys are encrypted at rest via OS `safeStorage`. If the
  OS keyring is unavailable the desktop **refuses** to store them in plaintext
  unless `AGENTPLEX_ALLOW_PLAINTEXT_KEYS=1` is set (insecure, dev only).
- Remote commands are gated by a protocol-version check and an allowlist before
  reaching the session manager.
- Revoke a lost device from desktop Settings → Remote access → trash icon.

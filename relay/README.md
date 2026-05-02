# AgentPlex Relay Server

E2EE relay that routes encrypted WebSocket messages between AgentPlex desktop instances and paired remote devices (web, iOS). The relay is a blind pipe — it cannot read terminal data.

## Prerequisites

- Go 1.23+
- (Optional) [Fly.io CLI](https://fly.io/docs/hands-on/install-flyctl/) for deployment

## First-time setup

```bash
cd relay
go mod tidy     # resolves dependencies, generates go.sum
go build ./cmd/relay
```

## Run locally

```bash
# Default: listens on :8080, SQLite at ./relay.db
./relay

# Custom config via environment
LISTEN_ADDR=:9090 DB_PATH=/tmp/relay.db JWT_SIGNING_KEY=<64-hex-chars> ./relay
```

## Test

```bash
curl http://localhost:8080/health
# → {"status":"ok","version":"0.1.0"}
```

## Deploy to Fly.io

```bash
cd relay
fly launch --name agentplex-relay
fly secrets set JWT_SIGNING_KEY=$(openssl rand -hex 32)
fly volumes create relay_data --size 1 --region iad
fly deploy
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LISTEN_ADDR` | `:8080` | Server listen address |
| `DB_PATH` | `./relay.db` | SQLite database path |
| `JWT_SIGNING_KEY` | (auto-generated) | Ed25519 seed, 32 bytes hex-encoded. Auto-generated if empty (key lost on restart). Set this in production. |

## Architecture

See `docs/proposals/relay-architecture.md` for the full design document.

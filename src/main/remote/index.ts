import * as http from 'http';
import * as net from 'net';
import { sessionManager } from '../session-manager';
import { loadOrCreateConfig } from './auth';
import { createRequestHandler, stopRateLimiter } from './http-server';
import { WsServer } from './ws-server';
import { RelayClient } from './relay-client';

let httpServer: http.Server | null = null;
let wsServer: WsServer | null = null;
let relayClient: RelayClient | null = null;

export interface RemoteServerInfo {
  port: number;
  token: string;
}

/** Check if a port is available by briefly listening on it. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => {
        tester.close(() => resolve(true));
      })
      .listen(port, '127.0.0.1');
  });
}

/**
 * Start the remote API server (HTTP + WebSocket).
 * Binds to localhost only by default.
 * Returns the port and token for logging/display.
 */
export async function startRemoteServer(): Promise<RemoteServerInfo> {
  const config = loadOrCreateConfig();

  if (!config.enabled) {
    console.log('[remote] Remote API server is disabled in config');
    return { port: 0, token: '' };
  }

  // Find a free port
  const candidates = [config.port, config.port + 1, config.port + 2, config.port + 3, 0];
  let chosenPort = 0;

  for (const port of candidates) {
    if (port === 0 || await isPortFree(port)) {
      chosenPort = port;
      break;
    }
    console.warn(`[remote] Port ${port} in use, trying next...`);
  }

  const requestHandler = createRequestHandler(sessionManager);
  httpServer = http.createServer(requestHandler);
  wsServer = new WsServer(httpServer, sessionManager);

  return new Promise((resolve) => {
    httpServer!.on('listening', () => {
      const addr = httpServer!.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : chosenPort;
      console.log(`[remote] API server listening on http://127.0.0.1:${actualPort}`);
      console.log(`[remote] WebSocket endpoint: ws://127.0.0.1:${actualPort}/ws?token=<token>`);
      console.log(`[remote] Token stored in ~/.agentplex/remote.json`);
      resolve({ port: actualPort, token: config.token });
    });

    httpServer!.on('error', (err: any) => {
      console.error('[remote] Server error:', err.message);
      resolve({ port: 0, token: config.token });
    });

    httpServer!.listen(chosenPort, '127.0.0.1');
  });
}

/** Stop the remote API server and clean up. */
export function stopRemoteServer() {
  stopRelayClient();

  if (wsServer) {
    wsServer.stop();
    wsServer = null;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  stopRateLimiter();
  console.log('[remote] API server stopped');
}

// ── Relay Client (outbound connection to cloud relay) ───────────────────────

/**
 * Start the relay client that connects to the cloud relay for E2EE remote access.
 * This is separate from the local API server — it connects outbound to the relay.
 */
export async function startRelayClient(relayUrl: string): Promise<RelayClient> {
  if (relayClient) {
    relayClient.stop();
  }

  relayClient = new RelayClient({ relayUrl });

  relayClient.on('connected', () => {
    console.log('[remote] Relay client connected');
  });

  relayClient.on('device-paired', (info: { deviceId: string; name: string }) => {
    console.log(`[remote] Device paired: ${info.name} (${info.deviceId})`);
  });

  await relayClient.start();
  return relayClient;
}

/** Stop the relay client. */
export function stopRelayClient() {
  if (relayClient) {
    relayClient.stop();
    relayClient = null;
  }
}

/** Get the current relay client instance (for pairing, device management, etc.) */
export function getRelayClient(): RelayClient | null {
  return relayClient;
}

/**
 * Relay Client — connects AgentPlex desktop to the relay server over an
 * outbound WebSocket. Handles authentication, E2EE encryption/decryption,
 * and bridges between the relay and the local SessionManager.
 *
 * Data flow:
 *   Remote Device → Relay → [WSS] → RelayClient → [decrypt] → SessionManager
 *   SessionManager → [events] → RelayClient → [encrypt] → [WSS] → Relay → Remote Device
 */

import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { sessionManager } from '../session-manager';
import { IPC } from '../../shared/ipc-channels';
import {
  getMachineId,
  getSigningPublicKeyBase64,
  getEncryptionPublicKeyBase64,
  sign,
  loadPairedDevices,
  addPairedDevice,
  removePairedDevice,
  generatePairingCode,
  hashPairingCode,
} from './key-manager';
import {
  encrypt,
  decrypt,
  getSessionKey,
  clearSessionKey,
  clearAllSessionKeys,
} from './e2ee';

// ── Types ───────────────────────────────────────────────────────────────────

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // timestamp ms
}

export interface RelayClientConfig {
  relayUrl: string; // e.g. "https://relay.agentplex.dev" or "http://localhost:8080"
}

type RelayClientState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';

// ── Client ──────────────────────────────────────────────────────────────────

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: RelayClientState = 'disconnected';
  private machineId: string;
  private tokens: TokenPair | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60_000;
  private eventUnsubscribers: (() => void)[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: RelayClientConfig) {
    super();
    this.machineId = getMachineId();
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /** Start the relay client: register, authenticate, connect WebSocket. */
  async start() {
    if (this.state !== 'disconnected') return;
    this.state = 'connecting';

    console.log(`[relay-client] Starting — machine: ${this.machineId}`);
    console.log(`[relay-client] Relay URL: ${this.config.relayUrl}`);

    try {
      await this.registerMachine();
      await this.authenticate();
      this.connectWebSocket();
    } catch (err: any) {
      console.error(`[relay-client] Start failed: ${err.message}`);
      this.state = 'disconnected';
      this.scheduleReconnect();
    }
  }

  /** Stop the relay client and clean up. */
  stop() {
    console.log('[relay-client] Stopping');
    this.state = 'disconnected';
    this.unsubscribeFromEvents();
    clearAllSessionKeys();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getState(): RelayClientState {
    return this.state;
  }

  getMachineId(): string {
    return this.machineId;
  }

  // ── Registration ──────────────────────────────────────────────────────

  /** Register this machine with the relay (idempotent). */
  private async registerMachine() {
    const resp = await this.httpPost('/register/machine', {
      machineId: this.machineId,
      publicKey: getSigningPublicKeyBase64(),
      encryptionKey: getEncryptionPublicKeyBase64(),
      displayName: require('os').hostname(),
    });

    if (!resp.ok) {
      console.log('[relay-client] Machine already registered or registration confirmed');
    }
    console.log('[relay-client] Machine registered with relay');
  }

  // ── Authentication ────────────────────────────────────────────────────

  /** Authenticate via Ed25519 challenge-response and obtain JWTs. */
  private async authenticate() {
    // If we have a valid refresh token, try refreshing first
    if (this.tokens?.refreshToken) {
      try {
        await this.refreshAccessToken();
        return;
      } catch {
        // Refresh failed, do full auth
      }
    }

    this.state = 'authenticating';

    // Step 1: Request challenge
    const challengeResp = await this.httpPost('/auth/challenge', { id: this.machineId });
    const { challenge } = challengeResp as { challenge: string };

    // Step 2: Sign the challenge with our Ed25519 private key
    const challengeBytes = Buffer.from(challenge, 'base64');
    const signature = sign(challengeBytes);

    // Step 3: Exchange signature for tokens
    const tokenResp = await this.httpPost('/auth/token', {
      id: this.machineId,
      signature,
    }) as { accessToken: string; refreshToken: string; expiresIn: number };

    this.tokens = {
      accessToken: tokenResp.accessToken,
      refreshToken: tokenResp.refreshToken,
      expiresAt: Date.now() + (tokenResp.expiresIn * 1000) - 30_000, // refresh 30s before expiry
    };

    console.log('[relay-client] Authenticated successfully');
  }

  /** Refresh the access token using the refresh token. */
  private async refreshAccessToken() {
    if (!this.tokens?.refreshToken) throw new Error('No refresh token');

    const resp = await this.httpPost('/auth/refresh', {
      refreshToken: this.tokens.refreshToken,
    }) as { accessToken: string; expiresIn: number };

    this.tokens.accessToken = resp.accessToken;
    this.tokens.expiresAt = Date.now() + (resp.expiresIn * 1000) - 30_000;

    console.log('[relay-client] Access token refreshed');
  }

  // ── WebSocket Connection ──────────────────────────────────────────────

  private connectWebSocket() {
    if (!this.tokens) return;

    const wsUrl = this.config.relayUrl.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${this.tokens.accessToken}` },
    });

    this.ws.on('open', () => {
      console.log('[relay-client] WebSocket connected to relay');
      this.state = 'connected';
      this.reconnectDelay = 1000; // reset backoff
      this.emit('connected');

      // Subscribe to SessionManager events for E2EE forwarding
      this.subscribeToEvents();

      // Start keepalive
      this.keepaliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30_000);
    });

    this.ws.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      try {
        const msg = JSON.parse(text);
        this.handleRelayMessage(msg);
      } catch {
        console.warn('[relay-client] Invalid message from relay');
      }
    });

    this.ws.on('close', (code, reason) => {
      console.log(`[relay-client] WebSocket closed: ${code} ${reason}`);
      this.cleanup();
      if (this.state !== 'disconnected') {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[relay-client] WebSocket error: ${err.message}`);
    });
  }

  // ── Incoming Message Handling ─────────────────────────────────────────

  private handleRelayMessage(msg: any) {
    switch (msg.type) {
      case 'envelope':
        this.handleEncryptedEnvelope(msg);
        break;

      case 'pair:completed':
        this.handlePairCompleted(msg);
        break;

      case 'pong':
        break; // keepalive response, ignore

      case 'error':
        console.error(`[relay-client] Relay error: ${msg.code} — ${msg.message}`);
        break;

      default:
        console.log(`[relay-client] Unknown message type: ${msg.type}`);
    }
  }

  /** Decrypt an incoming E2EE envelope and execute the command on SessionManager. */
  private handleEncryptedEnvelope(msg: { from: string; nonce: string; ct: string }) {
    const deviceId = msg.from;
    const device = loadPairedDevices().find(d => d.deviceId === deviceId);
    if (!device) {
      console.warn(`[relay-client] Envelope from unknown device: ${deviceId}`);
      return;
    }

    const sessionKey = getSessionKey(this.machineId, deviceId, device.encryptionKey);
    const plaintext = decrypt(sessionKey, this.machineId, deviceId, msg);
    if (!plaintext) {
      console.warn(`[relay-client] Failed to decrypt envelope from ${deviceId}`);
      return;
    }

    let command: any;
    try {
      command = JSON.parse(plaintext);
    } catch {
      console.warn('[relay-client] Decrypted envelope is not valid JSON');
      return;
    }

    this.executeRemoteCommand(command, deviceId);
  }

  /** Execute a decrypted command from a remote device. */
  private executeRemoteCommand(cmd: any, fromDeviceId: string) {
    switch (cmd.type) {
      case 'session:write':
        if (cmd.id && typeof cmd.data === 'string') {
          sessionManager.write(cmd.id, cmd.data);
        }
        break;

      case 'session:resize':
        if (cmd.id) {
          const cols = Math.max(1, Math.min(500, Math.floor(Number(cmd.cols) || 80)));
          const rows = Math.max(1, Math.min(200, Math.floor(Number(cmd.rows) || 24)));
          sessionManager.resize(cmd.id, cols, rows);
        }
        break;

      case 'session:create': {
        const info = sessionManager.create(cmd.cwd, cmd.cli || 'claude', cmd.resumeSessionId);
        this.sendEncryptedToDevice(fromDeviceId, { type: 'session:created', ...info });
        break;
      }

      case 'session:kill':
        if (cmd.id) sessionManager.kill(cmd.id);
        break;

      case 'session:list':
        this.sendEncryptedToDevice(fromDeviceId, { type: 'session:list', sessions: sessionManager.list() });
        break;

      case 'session:getBuffer':
        if (cmd.id) {
          this.sendEncryptedToDevice(fromDeviceId, {
            type: 'session:buffer',
            id: cmd.id,
            buffer: sessionManager.getBuffer(cmd.id),
          });
        }
        break;

      case 'session:subscribe':
        // The device is telling us which sessions it wants events for.
        // Store this preference — for now, we forward all events to all devices.
        break;

      case 'displayNames:get':
        this.sendEncryptedToDevice(fromDeviceId, {
          type: 'displayNames',
          names: sessionManager.getDisplayNames(),
        });
        break;

      default:
        console.log(`[relay-client] Unknown remote command: ${cmd.type}`);
    }
  }

  // ── Outgoing: Forward SessionManager Events ───────────────────────────

  private subscribeToEvents() {
    const em = sessionManager.events;

    const on = (channel: string, handler: (data: any) => void) => {
      em.on(channel, handler);
      this.eventUnsubscribers.push(() => em.off(channel, handler));
    };

    // Forward terminal data to all paired devices
    on(IPC.SESSION_DATA, (data: { id: string; data: string }) => {
      this.broadcastEncrypted({ type: 'session:data', id: data.id, data: data.data });
    });

    on(IPC.SESSION_STATUS, (data: { id: string; status: any }) => {
      this.broadcastEncrypted({ type: 'session:status', id: data.id, status: data.status });
    });

    on(IPC.SESSION_EXIT, (data: { id: string; exitCode: number }) => {
      this.broadcastEncrypted({ type: 'session:exit', id: data.id, exitCode: data.exitCode });
    });

    on(IPC.SUBAGENT_SPAWN, (data: any) => {
      this.broadcastEncrypted({
        type: 'subagent:spawn',
        sessionId: data.sessionId,
        subagentId: data.subagentId,
        description: data.description,
      });
    });

    on(IPC.SUBAGENT_COMPLETE, (data: any) => {
      this.broadcastEncrypted({
        type: 'subagent:complete',
        sessionId: data.sessionId,
        subagentId: data.subagentId,
      });
    });

    on(IPC.PLAN_ENTER, (data: any) => {
      this.broadcastEncrypted({ type: 'plan:enter', sessionId: data.sessionId, planTitle: data.planTitle });
    });

    on(IPC.PLAN_EXIT, (data: any) => {
      this.broadcastEncrypted({ type: 'plan:exit', sessionId: data.sessionId });
    });

    on(IPC.TASK_CREATE, (data: any) => {
      this.broadcastEncrypted({
        type: 'task:create',
        sessionId: data.sessionId,
        taskNumber: data.taskNumber,
        description: data.description,
      });
    });

    on(IPC.TASK_UPDATE, (data: any) => {
      this.broadcastEncrypted({
        type: 'task:update',
        sessionId: data.sessionId,
        taskNumber: data.taskNumber,
        status: data.status,
      });
    });

    on(IPC.TASK_LIST, (data: any) => {
      this.broadcastEncrypted({
        type: 'task:list',
        sessionId: data.sessionId,
        tasks: data.tasks,
      });
    });
  }

  private unsubscribeFromEvents() {
    for (const unsub of this.eventUnsubscribers) unsub();
    this.eventUnsubscribers.length = 0;
  }

  // ── E2EE Send Helpers ─────────────────────────────────────────────────

  /** Encrypt and send a message to a specific paired device via the relay. */
  private sendEncryptedToDevice(deviceId: string, payload: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const device = loadPairedDevices().find(d => d.deviceId === deviceId);
    if (!device) return;

    const sessionKey = getSessionKey(this.machineId, deviceId, device.encryptionKey);
    const envelope = encrypt(sessionKey, this.machineId, deviceId, JSON.stringify(payload));
    this.ws.send(JSON.stringify(envelope));
  }

  /** Encrypt and send a message to ALL paired devices. */
  private broadcastEncrypted(payload: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const devices = loadPairedDevices();
    const json = JSON.stringify(payload);

    for (const device of devices) {
      const sessionKey = getSessionKey(this.machineId, device.deviceId, device.encryptionKey);
      const envelope = encrypt(sessionKey, this.machineId, device.deviceId, json);
      this.ws.send(JSON.stringify(envelope));
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────

  /** Generate a pairing code and register it with the relay. Returns the 6-digit code. */
  async initiatePairing(): Promise<string> {
    const code = generatePairingCode();
    const codeHash = hashPairingCode(code);

    await this.httpPost('/pair/initiate', {
      codeHash,
      machineEncryptionKey: getEncryptionPublicKeyBase64(),
      ttl: 300,
    }, this.tokens?.accessToken);

    console.log(`[relay-client] Pairing initiated — code: ${code}`);
    return code;
  }

  /** Handle the relay's pair:completed event. */
  private handlePairCompleted(msg: {
    deviceId: string;
    deviceEncryptionKey: string;
    name: string;
    platform: string;
  }) {
    console.log(`[relay-client] Device paired: ${msg.name} (${msg.deviceId})`);

    addPairedDevice({
      deviceId: msg.deviceId,
      encryptionKey: msg.deviceEncryptionKey,
      name: msg.name,
      platform: msg.platform,
      pairedAt: new Date().toISOString(),
    });

    this.emit('device-paired', {
      deviceId: msg.deviceId,
      name: msg.name,
      platform: msg.platform,
    });
  }

  /** Revoke a paired device. */
  async revokeDevice(deviceId: string) {
    await this.httpRequest('DELETE', `/devices/${deviceId}`, undefined, this.tokens?.accessToken);
    removePairedDevice(deviceId);
    clearSessionKey(deviceId);
    console.log(`[relay-client] Device revoked: ${deviceId}`);
    this.emit('device-revoked', { deviceId });
  }

  // ── Reconnection ──────────────────────────────────────────────────────

  private scheduleReconnect() {
    if (this.state === 'disconnected') return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);

    console.log(`[relay-client] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.state = 'disconnected';
      await this.start();
    }, delay);
  }

  private cleanup() {
    this.unsubscribeFromEvents();
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.ws = null;
    if (this.state === 'connected') {
      this.state = 'disconnected';
    }
  }

  // ── HTTP Helpers ──────────────────────────────────────────────────────

  private async httpPost(path: string, body: any, token?: string): Promise<any> {
    return this.httpRequest('POST', path, body, token);
  }

  private async httpRequest(method: string, urlPath: string, body?: any, token?: string): Promise<any> {
    const url = `${this.config.relayUrl}${urlPath}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text}`);
    }

    return resp.json();
  }
}

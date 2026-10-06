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
import { hostname, homedir } from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { sessionManager } from '../session-manager';
import { IPC, CLI_TOOLS, RESUME_TOOL, COPILOT_RESUME_TOOL, REMOTE_PROTOCOL_VERSION, REMOTE_COMMAND_ALLOWLIST } from '../../shared/ipc-channels';
import { getCachedShells } from '../shell-detector';
import {
  getMachineId,
  getSigningPublicKeyBase64,
  getEncryptionPublicKeyBase64,
  sign,
  loadPairedDevices,
  savePairedDevices,
  addPairedDevice,
  removePairedDevice,
  generatePairingCode,
  hashPairingCode,
  createPairingProof,
  verifyPairingProof,
  rememberPairingSecret,
  getPairingSecret,
  forgetPairingSecret,
} from './key-manager';
import {
  encrypt,
  decrypt,
  getSessionKey,
  clearSessionKey,
  clearAllSessionKeys,
} from './e2ee';

// ── Remote command validation ────────────────────────────────────────────────

const COMMAND_ALLOWLIST = new Set<string>(REMOTE_COMMAND_ALLOWLIST);
const KNOWN_CLI_IDS = new Set<string>([
  ...CLI_TOOLS.map(t => t.id),
  RESUME_TOOL.id,
  COPILOT_RESUME_TOOL.id,
]);

/** Mirror of the local isValidCli guard so remote session:create can't request
 *  an unknown CLI; falls back to a detected shell id or 'claude'. */
function sanitizeRemoteCli(cli: unknown): string {
  if (cli === undefined) return 'claude';
  if (typeof cli !== 'string') throw new Error('CLI must be a string');
  if (KNOWN_CLI_IDS.has(cli)) return cli;
  if (getCachedShells().some(s => s.id === cli)) return cli;
  throw new Error(`Unsupported CLI or shell: ${cli}`);
}

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

class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export class RelayClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private state: RelayClientState = 'disconnected';
  private machineId: string;
  private tokens: TokenPair | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60_000;
  private stopped = true;
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
    this.stopped = false;
    this.setState('connecting');

    console.log(`[relay-client] Starting — machine: ${this.machineId}`);
    console.log(`[relay-client] Relay URL: ${this.config.relayUrl}`);

    try {
      await this.registerMachine();
      await this.authenticate();
      if (this.stopped) return;
      this.connectWebSocket();
    } catch (err: any) {
      console.error(`[relay-client] Start failed: ${err.message}`);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  /** Stop the relay client and clean up. */
  stop() {
    console.log('[relay-client] Stopping');
    this.stopped = true;
    this.setState('disconnected');
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

  /** Assign connection state and notify listeners (drives the Settings UI dot). */
  private setState(state: RelayClientState) {
    this.state = state;
    this.emit('state', state);
  }

  // ── Registration ──────────────────────────────────────────────────────

  /** Register this machine with the relay (idempotent). */
  private async registerMachine() {
    const resp = await this.httpPost('/register/machine', {
      machineId: this.machineId,
      publicKey: getSigningPublicKeyBase64(),
      encryptionKey: getEncryptionPublicKeyBase64(),
      displayName: hostname(),
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

    this.setState('authenticating');

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
      if (this.stopped) {
        this.ws?.close();
        return;
      }
      console.log('[relay-client] WebSocket connected to relay');
      this.setState('connected');
      this.reconnectDelay = 1000; // reset backoff
      this.emit('connected');

      // Subscribe to SessionManager events for E2EE forwarding
      this.subscribeToEvents();
      void this.reconcilePairedDevices();

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
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err) => {
      console.error(`[relay-client] WebSocket error: ${err.message}`);
    });
  }

  /** Reconcile persisted device keys after every reconnect. Pair completion can
   * happen while this machine socket is offline, so the one-shot WS event is not
   * sufficient to establish the local E2EE peer record. */
  private async reconcilePairedDevices() {
    try {
      const devices = await this.httpRequest(
        'GET',
        '/devices',
        undefined,
        this.tokens?.accessToken,
      ) as Array<{
        deviceId: string;
        publicKey: string;
        encryptionKey: string;
        codeHash: string;
        pairingProof: string;
        name: string;
        platform: string;
        pairedAt: string;
      }>;
      const existing = new Map(loadPairedDevices().map(device => [device.deviceId, device]));
      const verified = new Map(existing);
      for (const device of devices) {
        const pinned = existing.get(device.deviceId);
        if (pinned) {
          if (pinned.encryptionKey !== device.encryptionKey) {
            console.warn(`[relay-client] Ignoring relay key change for ${device.deviceId}`);
          }
          verified.set(device.deviceId, {
            ...pinned,
            name: device.name,
            platform: device.platform,
            pairedAt: device.pairedAt,
          });
          continue;
        }
        const code = getPairingSecret(device.codeHash);
        if (!code || !verifyPairingProof(
          code,
          device.pairingProof,
          'agentplex-pair-device-v1',
          this.machineId,
          getEncryptionPublicKeyBase64(),
          device.publicKey,
          device.encryptionKey,
        )) {
          console.warn(`[relay-client] Ignoring unverified paired device ${device.deviceId}`);
          continue;
        }
        verified.set(device.deviceId, {
          deviceId: device.deviceId,
          encryptionKey: device.encryptionKey,
          name: device.name,
          platform: device.platform,
          pairedAt: device.pairedAt,
        });
        savePairedDevices([...verified.values()]);
        forgetPairingSecret(device.codeHash);
      }
      savePairedDevices([...verified.values()]);
    } catch (err: any) {
      console.error(`[relay-client] Failed to reconcile paired devices: ${err.message}`);
    }
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
  private handleEncryptedEnvelope(msg: {
    from: string;
    epoch: string;
    seq: number;
    nonce: string;
    ct: string;
  }) {
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
    const requestId = typeof cmd?.requestId === 'string' ? cmd.requestId : undefined;
    try {
      const session = this.dispatchRemoteCommand(cmd, fromDeviceId);
      if (requestId) this.sendEncryptedToDevice(fromDeviceId, { type: 'command:result', requestId, session });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[relay-client] Command ${cmd?.type} failed: ${message}`);
      this.sendEncryptedToDevice(fromDeviceId, { type: 'command:result', requestId, error: message });
    }
  }

  private dispatchRemoteCommand(cmd: any, fromDeviceId: string) {
    // Reject anything that isn't a well-formed command object.
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') {
      throw new Error('Malformed remote command');
    }

    // Protocol version gate — reject incompatible major versions.
    if (cmd.v !== undefined && Math.floor(Number(cmd.v)) !== REMOTE_PROTOCOL_VERSION) {
      throw new Error('Incompatible remote protocol version');
    }

    // Command allowlist — only known, permitted commands reach SessionManager.
    if (!COMMAND_ALLOWLIST.has(cmd.type)) {
      throw new Error(`Unsupported remote command: ${cmd.type}`);
    }

    if (['session:write', 'session:resize', 'session:kill', 'session:rename', 'session:getBuffer'].includes(cmd.type)) {
      const session = sessionManager.list().find(s => s.id === cmd.id);
      if (!session) throw new Error('Session no longer exists; refresh the session list');
      if (session.status === 'killed' && ['session:write', 'session:resize'].includes(cmd.type)) {
        throw new Error('Session has stopped');
      }
    }

    switch (cmd.type) {
      case 'session:write':
        if (typeof cmd.data !== 'string' || cmd.data.length > 100_000) throw new Error('Invalid terminal input');
        sessionManager.write(cmd.id, cmd.data);
        break;

      case 'session:resize':
        if (typeof cmd.id === 'string') {
          const cols = Math.max(1, Math.min(500, Math.floor(Number(cmd.cols) || 80)));
          const rows = Math.max(1, Math.min(200, Math.floor(Number(cmd.rows) || 24)));
          sessionManager.resize(cmd.id, cols, rows);
        }
        break;

      case 'session:create': {
        const cwd = typeof cmd.cwd === 'string' ? cmd.cwd : undefined;
        if (cwd && (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory())) throw new Error('Choose an existing absolute directory on this machine');
        const cli = sanitizeRemoteCli(cmd.cli);
        const resumeSessionId = typeof cmd.resumeSessionId === 'string' ? cmd.resumeSessionId : undefined;
        const info = sessionManager.create(cwd, cli, resumeSessionId);
        this.sendEncryptedToDevice(fromDeviceId, { type: 'session:created', ...info });
        return info;
      }

      case 'session:rename':
        if (typeof cmd.name !== 'string' || !cmd.name.trim() || cmd.name.length > 200) throw new Error('Name must contain 1-200 characters');
        sessionManager.updateDisplayName(cmd.id, cmd.name.trim());
        break;

      case 'machine:capabilities':
        this.sendEncryptedToDevice(fromDeviceId, {
          type: 'machine:capabilities',
          home: homedir(),
          clis: [...CLI_TOOLS.map(({ id, label }) => ({ id, label })), ...getCachedShells().map(({ id, label }) => ({ id, label }))],
        });
        break;

      case 'session:kill':
        if (typeof cmd.id === 'string') sessionManager.kill(cmd.id);
        break;

      case 'session:list':
        this.sendEncryptedToDevice(fromDeviceId, {
          type: 'session:list', sessions: sessionManager.list(), names: sessionManager.getDisplayNames(),
        });
        break;

      case 'session:getBuffer':
        if (typeof cmd.id === 'string') {
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
    }
  }

  // ── Outgoing: Forward SessionManager Events ───────────────────────────

  private subscribeToEvents() {
    const em = sessionManager.events;

    const on = (channel: string, handler: (data: any) => void) => {
      em.on(channel, handler);
      this.eventUnsubscribers.push(() => em.off(channel, handler));
    };

    on(IPC.SESSION_CATALOG, (data) => {
      this.broadcastEncrypted({ type: 'session:list', ...data });
    });
    on(IPC.SESSION_INFO_UPDATE, (data) => {
      this.broadcastEncrypted({ type: 'session:info', ...data });
    });

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
    const json = JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, ...payload });
    const envelope = encrypt(sessionKey, this.machineId, deviceId, json);
    this.ws.send(JSON.stringify(envelope));
  }

  /** Encrypt and send a message to ALL paired devices. */
  private broadcastEncrypted(payload: any) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const devices = loadPairedDevices();
    const json = JSON.stringify({ v: REMOTE_PROTOCOL_VERSION, ...payload });

    for (const device of devices) {
      const sessionKey = getSessionKey(this.machineId, device.deviceId, device.encryptionKey);
      const envelope = encrypt(sessionKey, this.machineId, device.deviceId, json);
      this.ws.send(JSON.stringify(envelope));
    }
  }

  // ── Pairing ───────────────────────────────────────────────────────────

  /** Generate an out-of-band secret and register only its hash with the relay. */
  async initiatePairing(): Promise<string> {
    const code = generatePairingCode();
    const codeHash = hashPairingCode(code);
    const machineEncryptionKey = getEncryptionPublicKeyBase64();
    const machineProof = createPairingProof(
      code,
      'agentplex-pair-machine-v1',
      this.machineId,
      machineEncryptionKey,
    );

    await this.httpPost('/pair/initiate', {
      codeHash,
      machineEncryptionKey,
      machineProof,
      ttl: 300,
    }, this.tokens?.accessToken);

    rememberPairingSecret(codeHash, code);
    return code.match(/.{1,4}/g)?.join('-') ?? code;
  }

  /** Handle the relay's pair:completed event. */
  private handlePairCompleted(msg: {
    deviceId: string;
    deviceEncryptionKey: string;
    devicePublicKey: string;
    codeHash: string;
    deviceProof: string;
    name: string;
    platform: string;
  }) {
    const code = getPairingSecret(msg.codeHash);
    const machineEncryptionKey = getEncryptionPublicKeyBase64();
    if (!code || !verifyPairingProof(
      code,
      msg.deviceProof,
      'agentplex-pair-device-v1',
      this.machineId,
      machineEncryptionKey,
      msg.devicePublicKey,
      msg.deviceEncryptionKey,
    )) {
      console.warn('[relay-client] Rejected pairing with an invalid transcript proof');
      return;
    }
    forgetPairingSecret(msg.codeHash);
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
    try {
      await this.httpRequest('DELETE', `/devices/${deviceId}`, undefined, this.tokens?.accessToken);
    } catch (err) {
      // A locally remembered device may belong to a previous/reset relay
      // database. "Not found" already means it has no relay authorization, so
      // finish the local cleanup instead of trapping the stale record forever.
      if (!(err instanceof RelayHttpError) || err.status !== 404) throw err;
    }
    removePairedDevice(deviceId);
    clearSessionKey(deviceId);
    console.log(`[relay-client] Device revoked: ${deviceId}`);
    this.emit('device-revoked', { deviceId });
  }

  // ── Reconnection ──────────────────────────────────────────────────────

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;

    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);

    console.log(`[relay-client] Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.setState('disconnected');
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
      this.setState('disconnected');
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
      throw new RelayHttpError(resp.status, `HTTP ${resp.status}: ${text}`);
    }

    return resp.json();
  }
}

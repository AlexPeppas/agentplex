/**
 * RelayClient — connects to the relay as a paired device.
 */

import {
  getSigningPubKeyB64,
  signChallenge,
  getEncPubKeyB64,
  saveRefreshToken,
  getRefreshToken,
} from '../crypto/keys';
import {
  getSessionKey,
  encryptEnvelope,
  decryptEnvelope,
  hashPairingCode,
  createPairingProof,
  verifyPairingProof,
} from '../crypto/e2ee';
import { REMOTE_PROTOCOL_VERSION } from './types';
import type { MachineCommand, MachineEvent, PairedMachine, CommandResult } from './types';

type RelayState = 'disconnected' | 'connecting' | 'connected';

type EventHandler = (event: MachineEvent) => void;
type StatusHandler = (state: RelayState, machineOnline: boolean) => void;
type ErrorHandler = (msg: string) => void;

export class RelayClient {
  private ws: WebSocket | null = null;
  private accessToken: string | null = null;
  private state: RelayState = 'disconnected';
  private machineOnline = false;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private receiveQueue: Promise<void> = Promise.resolve();
  private pending = new Map<string, { resolve: (result: CommandResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private onEvent: EventHandler;
  private onStatus: StatusHandler;
  private onError: ErrorHandler;

  constructor(
    private machine: PairedMachine,
    handlers: { onEvent: EventHandler; onStatus: StatusHandler; onError?: ErrorHandler },
  ) {
    this.onEvent = handlers.onEvent;
    this.onStatus = handlers.onStatus;
    this.onError = handlers.onError ?? ((msg) => console.error('[relay-client]', msg));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start() {
    if (this.state !== 'disconnected') return;
    this.stopped = false;
    this.setState('connecting');
    console.log('[relay-client] Starting, relay:', this.machine.relayUrl);
    try {
      const currentEncryptionKey = await getEncPubKeyB64();
      if (currentEncryptionKey !== this.machine.deviceEncryptionKey) {
        throw new Error('Browser encryption keys changed — unpair and pair this machine again');
      }
      await this.authenticate();
      if (this.stopped) return;
      this.connectWebSocket();
    } catch (err: any) {
      const msg = `Auth failed: ${err.message}`;
      console.error('[relay-client]', msg);
      this.onError(msg);
      this.setState('disconnected');
      this.scheduleReconnect();
    }
  }

  stop() {
    this.stopped = true;
    this.reconnectDelay = 1000;
    this.clearTimers();
    this.rejectPending('Connection closed; command outcome may be unknown. Refresh before retrying.');
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  private async authenticate() {
    const deviceId = this.machine.deviceId;
    if (!deviceId) throw new Error('Not paired — no device ID for this machine');

    console.log('[relay-client] Authenticating device:', deviceId);

    // Try refresh first
    const refreshToken = await getRefreshToken(deviceId);
    if (refreshToken) {
      try {
        const resp = await this.post('/auth/refresh', { refreshToken });
        this.accessToken = resp.accessToken;
        console.log('[relay-client] Token refreshed');
        return;
      } catch (e: any) {
        console.warn('[relay-client] Refresh failed, doing full auth:', e.message);
      }
    }

    // Full Ed25519 challenge-response
    const challengeResp = await this.post('/auth/challenge', { id: deviceId });
    console.log('[relay-client] Got challenge, signing...');

    const signature = await signChallenge(challengeResp.challenge);
    const tokenResp = await this.post('/auth/token', { id: deviceId, signature });

    this.accessToken = tokenResp.accessToken;
    await saveRefreshToken(deviceId, tokenResp.refreshToken);
    console.log('[relay-client] Authenticated, JWT issued');
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private connectWebSocket() {
    if (!this.accessToken) return;
    const wsUrl = this.machine.relayUrl.replace(/^http/, 'ws') + '/ws';
    const url = `${wsUrl}?token=${encodeURIComponent(this.accessToken)}`;
    console.log('[relay-client] Connecting WS:', wsUrl);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) {
        ws.close();
        return;
      }
      console.log('[relay-client] WS open — sending connect for machine:', this.machine.machineId);
      this.reconnectDelay = 1000;
      this.setState('connected');

      this.wsSend({ type: 'connect', machineId: this.machine.machineId });
      this.keepaliveTimer = setInterval(() => this.wsSend({ type: 'ping' }), 30_000);

    };

    ws.onmessage = (ev) => {
      // Decrypt in wire order: concurrent key lookups can otherwise reorder
      // envelopes and trigger replay rejection or corrupt terminal output.
      this.receiveQueue = this.receiveQueue.then(async () => {
        if (this.ws === ws && !this.stopped) await this.handleRawMessage(ev.data as string);
      }).catch(e => this.onError(e instanceof Error ? e.message : String(e)));
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      console.log('[relay-client] WS closed:', ev.code, ev.reason);
      this.clearTimers();
      this.ws = null;
      this.rejectPending('Connection lost; command outcome may be unknown. Refresh before retrying.');
      if (!this.stopped) {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws || this.stopped) return;
      console.error('[relay-client] WS error (check relay is running at', this.machine.relayUrl, ')');
      this.onError(`Cannot connect to relay at ${this.machine.relayUrl}`);
    };
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private async handleRawMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

    console.log('[relay-client] ←', msg.type, msg.from ? `from:${msg.from}` : '');

    switch (msg.type) {
      case 'connected':
        console.log('[relay-client] Relay confirmed connection to machine');
        break;

      case 'machine:online':
        console.log('[relay-client] Machine is online');
        this.machineOnline = true;
        this.onStatus(this.state, true);
        if (this.syncTimer) clearInterval(this.syncTimer);
        let attempts = 0;
        const sync = () => {
          if (++attempts === 6) this.onError('Machine is online but encrypted session sync has not completed. Check desktop pairing.');
          void this.send({ type: 'session:list' }).catch(e => this.onError(e.message));
          void this.send({ type: 'machine:capabilities' }).catch(e => this.onError(e.message));
        };
        sync();
        // Pair completion can precede the machine's local allowlist update.
        // Retry only read-only discovery, never replay terminal input/mutations.
        this.syncTimer = setInterval(sync, 2000);
        break;

      case 'machine:offline':
        console.log('[relay-client] Machine went offline');
        this.machineOnline = false;
        if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
        this.rejectPending('Machine went offline; refresh before retrying the command.');
        this.onStatus(this.state, false);
        break;

      case 'envelope':
        await this.handleEnvelope(msg);
        break;

      case 'pong':
        break;

      case 'error':
        console.warn('[relay-client] Relay error:', msg.code, msg.message);
        this.onError(msg.message || 'Relay rejected the request');
        if (['NOT_PAIRED', 'DEVICE_REVOKED', 'DEVICE_NOT_FOUND'].includes(msg.code)) {
          this.stop();
        }
        break;
    }
  }

  private async handleEnvelope(msg: {
    epoch: string;
    seq: number;
    nonce: string;
    ct: string;
    from: string;
  }) {
    const deviceId = this.machine.deviceId;
    if (!deviceId) { console.error('[relay-client] No deviceId for decryption'); return; }
    if (msg.from !== this.machine.machineId) throw new Error('Unexpected machine sender');

    console.log('[relay-client] Decrypting envelope from', msg.from);

    const sessionKey = await getSessionKey(
      this.machine.machineId,
      deviceId,
      this.machine.machineEncryptionKey,
    );

    const plaintext = decryptEnvelope(
      sessionKey,
      this.machine.machineId,
      deviceId,
      msg,
    );

    if (!plaintext) {
      console.error('[relay-client] Decryption FAILED — key mismatch or tampered data');
      this.onError('E2EE decryption failed — repair may be needed');
      return;
    }

    const event = JSON.parse(plaintext) as MachineEvent & { v?: number };
    if (event.v !== REMOTE_PROTOCOL_VERSION) throw new Error('Machine protocol is incompatible; update AgentPlex');
    if (event.type === 'session:list' && this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    if (event.type === 'command:result' && event.requestId) {
      const pending = this.pending.get(event.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(event.requestId);
        if (event.error) pending.reject(new Error(event.error));
        else pending.resolve(event);
      }
    }
    this.onEvent(event);
  }

  // ── Send commands to machine ───────────────────────────────────────────────

  send(command: MachineCommand): Promise<void> {
    const ws = this.ws;
    const task = this.sendQueue.then(() => {
      if (this.ws !== ws || this.stopped) throw new Error('Connection changed; command was not sent');
      return this.sendNow(command);
    });
    this.sendQueue = task.catch(() => undefined);
    return task;
  }

  request(command: MachineCommand): Promise<CommandResult> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('No machine response. Command outcome is unknown; refresh before retrying.'));
      }, 15_000);
      this.pending.set(requestId, { resolve, reject, timer });
      void this.send({ ...command, requestId }).catch(error => {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  private rejectPending(message: string) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(message));
    }
    this.pending.clear();
  }

  private async sendNow(command: MachineCommand) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Relay is disconnected; command was not sent');
    }
    if (!this.machineOnline) throw new Error('Machine is offline; command was not sent');

    const deviceId = this.machine.deviceId;
    if (!deviceId) throw new Error('Device is not paired');

    const sessionKey = await getSessionKey(
      this.machine.machineId,
      deviceId,
      this.machine.machineEncryptionKey,
    );

    const envelope = await encryptEnvelope(
      sessionKey,
      this.machine.machineId,
      deviceId,
      this.machine.machineId,
      { v: REMOTE_PROTOCOL_VERSION, ...command },
    );

    // Re-check after awaits — WS could have closed
    if (this.ws !== ws || ws.readyState !== WebSocket.OPEN || this.stopped || !this.machineOnline) {
      throw new Error('Connection changed during encryption; command was not sent');
    }

    console.log('[relay-client] →', command.type);
    this.ws.send(JSON.stringify(envelope));
  }

  // ── Pairing ───────────────────────────────────────────────────────────────

  static async completePairing(
    relayUrl: string,
    machineId: string,
    code: string,
    deviceName: string,
    machineLabel?: string,
  ): Promise<PairedMachine> {
    const pubKeyB64 = await getSigningPubKeyB64();
    const encPubKeyB64 = await getEncPubKeyB64();
    const codeHash = hashPairingCode(code);

    console.log('[pairing] Completing pairing with machine:', machineId);

    const infoResp = await fetch(`${relayUrl}/pair/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ machineId, codeHash }),
    });
    if (!infoResp.ok) {
      const err = await infoResp.json().catch(() => ({})) as any;
      throw new Error(err.message || `Pairing lookup failed: ${infoResp.status}`);
    }
    const pairInfo = await infoResp.json() as {
      machineId: string;
      machineEncryptionKey: string;
      machineProof: string;
    };
    if (!verifyPairingProof(
      code,
      pairInfo.machineProof,
      'agentplex-pair-machine-v1',
      pairInfo.machineId,
      pairInfo.machineEncryptionKey,
    )) {
      throw new Error('Pairing machine authentication failed');
    }

    const resp = await fetch(`${relayUrl}/pair/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        codeHash,
        devicePublicKey: pubKeyB64,
        deviceEncryptionKey: encPubKeyB64,
        deviceProof: createPairingProof(
          code,
          'agentplex-pair-device-v1',
          machineId,
          pairInfo.machineEncryptionKey,
          pubKeyB64,
          encPubKeyB64,
        ),
        platform: 'web',
        name: deviceName,
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      throw new Error(err.message || `Pairing failed: ${resp.status}`);
    }

    const data = await resp.json() as {
      deviceId: string;
      machineId: string;
      machineEncryptionKey: string;
      machineProof: string;
    };

    if (!verifyPairingProof(
      code,
      data.machineProof,
      'agentplex-pair-machine-v1',
      data.machineId,
      data.machineEncryptionKey,
    )) {
      throw new Error('Pairing transcript authentication failed');
    }
    if (data.machineEncryptionKey !== pairInfo.machineEncryptionKey) {
      throw new Error('Pairing machine key changed during completion');
    }

    console.log('[pairing] Success — deviceId:', data.deviceId);

    return {
      machineId: data.machineId,
      machineEncryptionKey: data.machineEncryptionKey,
      deviceId: data.deviceId,
      deviceEncryptionKey: encPubKeyB64,
      relayUrl,
      name: machineLabel?.trim() || `Machine ${data.machineId.slice(0, 8)}`,
      pairedAt: new Date().toISOString(),
    };
  }

  /** The machine id this client is paired to. */
  getMachineId(): string {
    return this.machine.machineId;
  }

  async revokeDevice(deviceId: string) {
    await this.httpRequest('DELETE', `/devices/${deviceId}`, undefined, this.accessToken ?? undefined);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private wsSend(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async post(path: string, body: object): Promise<any> {
    return this.httpRequest('POST', path, body);
  }

  private async httpRequest(method: string, path: string, body?: object, token?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const resp = await fetch(`${this.machine.relayUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      throw new Error(err.message || `HTTP ${resp.status} from ${path}`);
    }
    return resp.json();
  }

  private setState(state: RelayState) {
    this.state = state;
    if (state !== 'connected') this.machineOnline = false;
    this.onStatus(state, this.machineOnline);
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    console.log(`[relay-client] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) void this.start();
    }, delay);
  }

  private clearTimers() {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  }
}

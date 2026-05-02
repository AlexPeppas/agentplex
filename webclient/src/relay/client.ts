/**
 * RelayClient — connects to the relay as a paired device.
 */

import {
  getSigningPubKeyB64,
  signChallenge,
  getEncPubKeyB64,
  getDeviceId,
  saveDeviceId,
  saveRefreshToken,
  getRefreshToken,
} from '../crypto/keys';
import { getSessionKey, encryptEnvelope, decryptEnvelope } from '../crypto/e2ee';
import type { MachineCommand, MachineEvent, PairedMachine } from './types';

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
    this.setState('connecting');
    console.log('[relay-client] Starting, relay:', this.machine.relayUrl);
    try {
      await this.authenticate();
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
    this.reconnectDelay = 1000;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }

  // ── Authentication ─────────────────────────────────────────────────────────

  private async authenticate() {
    const deviceId = await getDeviceId();
    if (!deviceId) throw new Error('Not paired — no device ID in storage');

    console.log('[relay-client] Authenticating device:', deviceId);

    // Try refresh first
    const refreshToken = await getRefreshToken();
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
    await saveRefreshToken(tokenResp.refreshToken);
    console.log('[relay-client] Authenticated, JWT issued');
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  private connectWebSocket() {
    if (!this.accessToken) return;
    const wsUrl = this.machine.relayUrl.replace(/^http/, 'ws') + '/ws';
    const url = `${wsUrl}?token=${encodeURIComponent(this.accessToken)}`;
    console.log('[relay-client] Connecting WS:', wsUrl);

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[relay-client] WS open — sending connect for machine:', this.machine.machineId);
      this.reconnectDelay = 1000;
      this.setState('connected');

      this.wsSend({ type: 'connect', machineId: this.machine.machineId });
      this.keepaliveTimer = setInterval(() => this.wsSend({ type: 'ping' }), 30_000);

      // Request initial state — small delay to ensure connect is processed
      setTimeout(() => {
        console.log('[relay-client] Requesting session list...');
        this.send({ type: 'session:list' }).catch(e =>
          console.error('[relay-client] session:list send failed:', e)
        );
        this.send({ type: 'displayNames:get' }).catch(e =>
          console.error('[relay-client] displayNames send failed:', e)
        );
      }, 200);
    };

    this.ws.onmessage = (ev) => {
      this.handleRawMessage(ev.data as string).catch(e =>
        console.error('[relay-client] handleRawMessage error:', e)
      );
    };

    this.ws.onclose = (ev) => {
      console.log('[relay-client] WS closed:', ev.code, ev.reason);
      this.clearTimers();
      this.ws = null;
      if (this.state !== 'disconnected') {
        this.setState('disconnected');
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
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
        await this.send({ type: 'session:list' });
        await this.send({ type: 'displayNames:get' });
        break;

      case 'machine:offline':
        console.log('[relay-client] Machine went offline');
        this.machineOnline = false;
        this.onStatus(this.state, false);
        break;

      case 'envelope':
        await this.handleEnvelope(msg);
        break;

      case 'pong':
        break;

      case 'error':
        console.warn('[relay-client] Relay error:', msg.code, msg.message);
        if (msg.code === 'NOT_PAIRED') this.onError('Device is not paired with this machine');
        break;
    }
  }

  private async handleEnvelope(msg: { nonce: string; ct: string; from: string }) {
    const deviceId = await getDeviceId();
    if (!deviceId) { console.error('[relay-client] No deviceId for decryption'); return; }

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

    try {
      const event = JSON.parse(plaintext) as MachineEvent;
      console.log('[relay-client] ✓ Decrypted event:', event.type);
      this.onEvent(event);
    } catch (e) {
      console.error('[relay-client] Decrypted payload is not valid JSON:', plaintext.slice(0, 100));
    }
  }

  // ── Send commands to machine ───────────────────────────────────────────────

  async send(command: MachineCommand) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('[relay-client] send() skipped — WS not open, cmd:', command.type);
      return;
    }

    const deviceId = await getDeviceId();
    if (!deviceId) { console.error('[relay-client] No deviceId, cannot send'); return; }

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
      command,
    );

    // Re-check after awaits — WS could have closed
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[relay-client] WS closed during encryption, dropping:', command.type);
      return;
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
  ): Promise<PairedMachine> {
    const pubKeyB64 = await getSigningPubKeyB64();
    const encPubKeyB64 = await getEncPubKeyB64();

    console.log('[pairing] Completing pairing with machine:', machineId);

    const resp = await fetch(`${relayUrl}/pair/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        machineId,
        code,
        devicePublicKey: pubKeyB64,
        deviceEncryptionKey: encPubKeyB64,
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
    };

    console.log('[pairing] Success — deviceId:', data.deviceId);
    await saveDeviceId(data.deviceId);

    return {
      machineId: data.machineId,
      machineEncryptionKey: data.machineEncryptionKey,
      deviceId: data.deviceId,
      deviceEncryptionKey: encPubKeyB64,
      relayUrl,
      name: 'AgentPlex Machine',
      pairedAt: new Date().toISOString(),
    };
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
    this.onStatus(state, this.machineOnline);
  }

  private scheduleReconnect() {
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    console.log(`[relay-client] Reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => this.start(), delay);
  }

  private clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
  }
}

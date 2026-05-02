import type { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { SessionManager } from '../session-manager';
import { IPC } from '../../shared/ipc-channels';
import { extractQueryToken, validateToken } from './auth';
import { RateLimiter } from './rate-limiter';
import type { WsClientMessage, WsServerMessage } from './types';

// Rate limit: 200 WS messages per 10 seconds per connection
const wsRateLimiter = new RateLimiter(200, 10_000);
// Higher limit for terminal write (typing is bursty)
const writeRateLimiter = new RateLimiter(500, 10_000);

interface ClientState {
  id: string;
  subscribedSessions: Set<string>;
  subscribeAll: boolean;
}

let clientIdCounter = 0;

export class WsServer {
  private wss: WebSocketServer;
  private clients = new Map<WebSocket, ClientState>();
  private eventUnsubscribers: (() => void)[] = [];

  constructor(
    httpServer: HttpServer,
    private sessionManager: SessionManager,
  ) {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle HTTP upgrade with auth
    httpServer.on('upgrade', (req: IncomingMessage, socket, head) => {
      const url = req.url || '';

      // Only accept upgrades to /ws
      if (!url.startsWith('/ws')) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Auth via query param
      const token = extractQueryToken(url);
      if (!token || !validateToken(token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const state: ClientState = {
        id: `ws-${++clientIdCounter}`,
        subscribedSessions: new Set(),
        subscribeAll: false,
      };
      this.clients.set(ws, state);
      console.log(`[remote/ws] Client connected: ${state.id}`);

      ws.on('message', (raw: Buffer | string) => {
        // Rate limit
        if (!wsRateLimiter.check(state.id)) {
          this.sendToClient(ws, { type: 'error', error: 'Rate limited', code: 'RATE_LIMITED' });
          return;
        }

        let msg: WsClientMessage;
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf-8'));
        } catch {
          this.sendToClient(ws, { type: 'error', error: 'Invalid JSON', code: 'PARSE_ERROR' });
          return;
        }

        this.handleClientMessage(ws, state, msg);
      });

      ws.on('close', () => {
        console.log(`[remote/ws] Client disconnected: ${state.id}`);
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error(`[remote/ws] Client ${state.id} error:`, err.message);
        this.clients.delete(ws);
      });
    });

    // Subscribe to SessionManager events and broadcast to WS clients
    this.subscribeToEvents();
  }

  private handleClientMessage(ws: WebSocket, state: ClientState, msg: WsClientMessage) {
    switch (msg.type) {
      case 'session:write': {
        if (!msg.id || typeof msg.data !== 'string') return;
        if (!writeRateLimiter.check(state.id)) {
          this.sendToClient(ws, { type: 'error', error: 'Write rate limited', code: 'RATE_LIMITED' });
          return;
        }
        this.sessionManager.write(msg.id, msg.data);
        break;
      }

      case 'session:resize': {
        if (!msg.id) return;
        const cols = Math.max(1, Math.min(500, Math.floor(Number(msg.cols) || 80)));
        const rows = Math.max(1, Math.min(200, Math.floor(Number(msg.rows) || 24)));
        this.sessionManager.resize(msg.id, cols, rows);
        break;
      }

      case 'subscribe': {
        if (msg.sessions === '*') {
          state.subscribeAll = true;
        } else if (Array.isArray(msg.sessions)) {
          for (const id of msg.sessions) {
            state.subscribedSessions.add(id);
          }
        }
        break;
      }

      case 'unsubscribe': {
        if (msg.sessions === '*') {
          state.subscribeAll = false;
          state.subscribedSessions.clear();
        } else if (Array.isArray(msg.sessions)) {
          for (const id of msg.sessions) {
            state.subscribedSessions.delete(id);
          }
        }
        break;
      }

      case 'session:updateState': {
        if (!msg.sessionId || typeof msg.displayName !== 'string') return;
        this.sessionManager.updateDisplayName(msg.sessionId, msg.displayName.slice(0, 200));
        break;
      }

      default:
        this.sendToClient(ws, { type: 'error', error: `Unknown message type: ${(msg as any).type}`, code: 'UNKNOWN_TYPE' });
    }
  }

  private subscribeToEvents() {
    const em = this.sessionManager.events;

    const on = (channel: string, handler: (data: any) => void) => {
      em.on(channel, handler);
      this.eventUnsubscribers.push(() => em.off(channel, handler));
    };

    // Terminal output — highest volume, check backpressure
    on(IPC.SESSION_DATA, (data: { id: string; data: string }) => {
      this.broadcast(data.id, { type: 'session:data', id: data.id, data: data.data });
    });

    on(IPC.SESSION_STATUS, (data: { id: string; status: any }) => {
      this.broadcast(data.id, { type: 'session:status', id: data.id, status: data.status });
    });

    on(IPC.SESSION_EXIT, (data: { id: string; exitCode: number }) => {
      this.broadcast(data.id, { type: 'session:exit', id: data.id, exitCode: data.exitCode });
    });

    on(IPC.SUBAGENT_SPAWN, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'subagent:spawn',
        sessionId: data.sessionId,
        subagentId: data.subagentId,
        description: data.description,
      });
    });

    on(IPC.SUBAGENT_COMPLETE, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'subagent:complete',
        sessionId: data.sessionId,
        subagentId: data.subagentId,
      });
    });

    on(IPC.PLAN_ENTER, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'plan:enter',
        sessionId: data.sessionId,
        planTitle: data.planTitle,
      });
    });

    on(IPC.PLAN_EXIT, (data: any) => {
      this.broadcast(data.sessionId, { type: 'plan:exit', sessionId: data.sessionId });
    });

    on(IPC.TASK_CREATE, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'task:create',
        sessionId: data.sessionId,
        taskNumber: data.taskNumber,
        description: data.description,
      });
    });

    on(IPC.TASK_UPDATE, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'task:update',
        sessionId: data.sessionId,
        taskNumber: data.taskNumber,
        status: data.status,
      });
    });

    on(IPC.TASK_LIST, (data: any) => {
      this.broadcast(data.sessionId, {
        type: 'task:list',
        sessionId: data.sessionId,
        tasks: data.tasks,
      });
    });
  }

  /** Broadcast an event to all clients subscribed to a given session. */
  private broadcast(sessionId: string, message: WsServerMessage) {
    const json = JSON.stringify(message);

    for (const [ws, state] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;

      // Check subscription
      if (!state.subscribeAll && !state.subscribedSessions.has(sessionId)) continue;

      // Backpressure: skip if the client's send buffer is too full (1MB)
      if (ws.bufferedAmount > 1_048_576) continue;

      ws.send(json);
    }
  }

  private sendToClient(ws: WebSocket, message: WsServerMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  stop() {
    // Unsubscribe from SessionManager events
    for (const unsub of this.eventUnsubscribers) unsub();
    this.eventUnsubscribers.length = 0;

    // Close all connections
    for (const ws of this.clients.keys()) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    this.clients.clear();

    wsRateLimiter.stop();
    writeRateLimiter.stop();

    this.wss.close();
  }
}

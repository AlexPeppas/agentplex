import type { SessionStatus } from '../../shared/ipc-channels';

// ── Client → Server (WebSocket commands) ────────────────────────────────────

export interface WsWriteMessage {
  type: 'session:write';
  id: string;
  data: string;
}

export interface WsResizeMessage {
  type: 'session:resize';
  id: string;
  cols: number;
  rows: number;
}

export interface WsSubscribeMessage {
  type: 'subscribe';
  /** Array of session IDs, or "*" to subscribe to all */
  sessions: string[] | '*';
}

export interface WsUnsubscribeMessage {
  type: 'unsubscribe';
  sessions: string[] | '*';
}

export interface WsUpdateStateMessage {
  type: 'session:updateState';
  sessionId: string;
  displayName: string;
}

export type WsClientMessage =
  | WsWriteMessage
  | WsResizeMessage
  | WsSubscribeMessage
  | WsUnsubscribeMessage
  | WsUpdateStateMessage;

// ── Server → Client (WebSocket events) ──────────────────────────────────────

export interface WsSessionDataEvent {
  type: 'session:data';
  id: string;
  data: string;
}

export interface WsSessionStatusEvent {
  type: 'session:status';
  id: string;
  status: SessionStatus;
}

export interface WsSessionExitEvent {
  type: 'session:exit';
  id: string;
  exitCode: number;
}

export interface WsSubagentSpawnEvent {
  type: 'subagent:spawn';
  sessionId: string;
  subagentId: string;
  description: string;
}

export interface WsSubagentCompleteEvent {
  type: 'subagent:complete';
  sessionId: string;
  subagentId: string;
}

export interface WsPlanEnterEvent {
  type: 'plan:enter';
  sessionId: string;
  planTitle: string;
}

export interface WsPlanExitEvent {
  type: 'plan:exit';
  sessionId: string;
}

export interface WsTaskCreateEvent {
  type: 'task:create';
  sessionId: string;
  taskNumber: number;
  description: string;
}

export interface WsTaskUpdateEvent {
  type: 'task:update';
  sessionId: string;
  taskNumber: number;
  status: string;
}

export interface WsTaskListEvent {
  type: 'task:list';
  sessionId: string;
  tasks: { taskNumber: number; description: string; status: string }[];
}

export interface WsErrorEvent {
  type: 'error';
  error: string;
  code: string;
}

export type WsServerMessage =
  | WsSessionDataEvent
  | WsSessionStatusEvent
  | WsSessionExitEvent
  | WsSubagentSpawnEvent
  | WsSubagentCompleteEvent
  | WsPlanEnterEvent
  | WsPlanExitEvent
  | WsTaskCreateEvent
  | WsTaskUpdateEvent
  | WsTaskListEvent
  | WsErrorEvent;

// ── HTTP API types ──────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
}

export interface RemoteConfig {
  token: string;
  port: number;
  enabled: boolean;
}

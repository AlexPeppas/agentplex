// Shared types mirroring the relay server's api/messages.go
import type { SessionTraceSnapshot, SessionTraceEvent } from '../../../src/shared/session-trace';
export { EMPTY_TRACE } from '../../../src/shared/session-trace';
export type { SessionTrace, SubagentEntry, PlanEntry, TaskStatus, TaskEntry } from '../../../src/shared/session-trace';

/** Wire protocol version stamped on outgoing commands (matches the desktop). */
export const REMOTE_PROTOCOL_VERSION = 1;

export interface PairedMachine {
  machineId: string;
  machineEncryptionKey: string; // X25519 public key, base64
  name: string;
  relayUrl: string;
  deviceId: string;
  deviceEncryptionKey: string; // our own X25519 pub, base64 (stored for reference)
  pairedAt: string;
}

export type SessionStatus = 'running' | 'idle' | 'waiting-for-input' | 'killed';

export interface SessionInfo {
  windowsPty?: { backend: 'conpty' | 'winpty'; buildNumber: number };
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
  cwd: string;
  cli: string;
  resumeSessionId: string | null;
  /**
   * The machine this session belongs to. Injected by the store when a session
   * arrives from a given machine's RelayClient — never present on the wire,
   * since session ids are only unique within a single machine.
   */
  machineId: string;
}

export type RelayConnState = 'disconnected' | 'connecting' | 'connected';

/** Per-machine connection status tracked in the store. */
export interface MachineStatus {
  relayState: RelayConnState;
  online: boolean;
  error: string | null;
  ready?: boolean;
  traceReady?: boolean;
}

export interface MachineCapabilities {
  home: string;
  clis: { id: string; label: string }[];
}

export type CommandResult = { type: 'command:result'; requestId?: string; error?: string; session?: Omit<SessionInfo, 'machineId'> };

// ── Live "trace" state mirrored from the desktop event stream ─────────────────
// The desktop emits structured subagent/plan/task events over the same E2EE
// channel; the web client renders them in real time for a faithful mirror.

// Decrypted messages we receive from the machine
export type MachineEvent =
  | { type: 'session:data';    id: string; data: string }
  | { type: 'session:status';  id: string; status: SessionStatus }
  | { type: 'session:exit';    id: string; exitCode: number }
  | { type: 'session:list';    sessions: Omit<SessionInfo, 'machineId'>[]; names?: Record<string, string>; traces?: Record<string, SessionTraceSnapshot> }
  | ({ type: 'session:created' } & Omit<SessionInfo, 'machineId'>)
  | ({ type: 'session:info'; id: string } & Partial<Omit<SessionInfo, 'machineId'>>)
  | ({ type: 'machine:capabilities' } & MachineCapabilities)
  | CommandResult
  | { type: 'session:buffer';  id: string; buffer: string }
  | { type: 'displayNames';    names: Record<string, string> }
  | SessionTraceEvent;

// Commands we send to the machine (encrypted)
export type MachineCommand = (
  | { type: 'session:list' }
  | { type: 'session:write';     id: string; data: string }
  | { type: 'session:resize';    id: string; cols: number; rows: number }
  | { type: 'session:create';    cwd?: string; cli?: string; resumeSessionId?: string }
  | { type: 'session:kill';      id: string }
  | { type: 'session:rename';    id: string; name: string }
  | { type: 'machine:capabilities' }
  | { type: 'session:getBuffer'; id: string }
  | { type: 'displayNames:get' }
) & { requestId?: string };

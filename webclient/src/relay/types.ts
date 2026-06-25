// Shared types mirroring the relay server's api/messages.go

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
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
  cwd: string;
  cli: string;
  claudeSessionUuid: string | null;
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
}

// ── Live "trace" state mirrored from the desktop event stream ─────────────────
// The desktop emits structured subagent/plan/task events over the same E2EE
// channel; the web client renders them in real time for a faithful mirror.

export interface SubagentEntry {
  subagentId: string;
  description: string;
  status: 'active' | 'completed';
}

export interface PlanEntry {
  title: string;
  status: 'active' | 'completed';
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskEntry {
  taskNumber: number;
  description: string;
  status: TaskStatus;
}

export interface SessionTrace {
  mode: 'normal' | 'plan';
  plans: PlanEntry[];
  tasks: TaskEntry[];
  subagents: SubagentEntry[];
}

export const EMPTY_TRACE: SessionTrace = { mode: 'normal', plans: [], tasks: [], subagents: [] };

// Decrypted messages we receive from the machine
export type MachineEvent =
  | { type: 'session:data';    id: string; data: string }
  | { type: 'session:status';  id: string; status: SessionStatus }
  | { type: 'session:exit';    id: string; exitCode: number }
  | { type: 'session:list';    sessions: SessionInfo[] }
  | { type: 'session:created'; id: string; title: string; status: SessionStatus; pid: number; cwd: string; cli: string; claudeSessionUuid: string | null }
  | { type: 'session:buffer';  id: string; buffer: string }
  | { type: 'displayNames';    names: Record<string, string> }
  | { type: 'subagent:spawn';  sessionId: string; subagentId: string; description: string }
  | { type: 'subagent:complete'; sessionId: string; subagentId: string }
  | { type: 'plan:enter';      sessionId: string; planTitle: string }
  | { type: 'plan:exit';       sessionId: string }
  | { type: 'task:create';     sessionId: string; taskNumber: number; description: string }
  | { type: 'task:update';     sessionId: string; taskNumber: number; status: string }
  | { type: 'task:list';       sessionId: string; tasks: Array<{ taskNumber: number; description: string; status: string }> };

// Commands we send to the machine (encrypted)
export type MachineCommand =
  | { type: 'session:list' }
  | { type: 'session:write';     id: string; data: string }
  | { type: 'session:resize';    id: string; cols: number; rows: number }
  | { type: 'session:create';    cwd?: string; cli?: string; resumeSessionId?: string }
  | { type: 'session:kill';      id: string }
  | { type: 'session:getBuffer'; id: string }
  | { type: 'displayNames:get' };

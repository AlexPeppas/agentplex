// Shared types mirroring the relay server's api/messages.go

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
}

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

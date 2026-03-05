import type { SessionInfo, SessionStatus, SubagentInfo } from '../shared/ipc-channels';

export interface AgentFieldAPI {
  createSession: (cwd?: string) => Promise<SessionInfo>;
  pickDirectory: () => Promise<string | null>;
  writeSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => Promise<void>;
  listSessions: () => Promise<SessionInfo[]>;
  onSessionData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onSessionStatus: (callback: (data: { id: string; status: SessionStatus }) => void) => () => void;
  onSessionExit: (callback: (data: { id: string; exitCode: number }) => void) => () => void;
  onSubagentSpawn: (callback: (data: SubagentInfo) => void) => () => void;
  onSubagentComplete: (callback: (data: SubagentInfo) => void) => () => void;
}

declare global {
  interface Window {
    agentField: AgentFieldAPI;
  }
}

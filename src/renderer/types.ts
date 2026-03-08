import type { SessionInfo, SessionStatus, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo } from '../shared/ipc-channels';

export interface AgentFieldAPI {
  createSession: (cwd?: string) => Promise<SessionInfo>;
  pickDirectory: () => Promise<string | null>;
  writeSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => Promise<void>;
  listSessions: () => Promise<SessionInfo[]>;
  getSessionBuffer: (id: string) => Promise<string>;
  onSessionData: (callback: (data: { id: string; data: string }) => void) => () => void;
  onSessionStatus: (callback: (data: { id: string; status: SessionStatus }) => void) => () => void;
  onSessionExit: (callback: (data: { id: string; exitCode: number }) => void) => () => void;
  onSubagentSpawn: (callback: (data: SubagentInfo) => void) => () => void;
  onSubagentComplete: (callback: (data: SubagentInfo) => void) => () => void;
  onPlanEnter: (callback: (data: PlanInfo) => void) => () => void;
  onPlanExit: (callback: (data: { sessionId: string }) => void) => () => void;
  onTaskCreate: (callback: (data: TaskInfo) => void) => () => void;
  onTaskUpdate: (callback: (data: TaskUpdateInfo) => void) => () => void;
  onTaskList: (callback: (data: TaskListInfo) => void) => () => void;
}

declare global {
  interface Window {
    agentField: AgentFieldAPI;
  }
}

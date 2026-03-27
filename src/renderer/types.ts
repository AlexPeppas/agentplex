import type { CliTool, DetectedShell, SessionInfo, SessionStatus, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo, ExternalSession, DiscoveredProject, DiscoveredSession, PinnedProject, GitStatusResult, GitFileDiffResult } from '../shared/ipc-channels';

export interface AgentPlexAPI {
  platform: string;
  createSession: (cwd?: string, cli?: CliTool, resumeSessionId?: string) => Promise<SessionInfo>;
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
  updateSessionState: (sessionId: string, displayName: string) => void;
  restoreAllSessions: () => Promise<{ info: SessionInfo; displayName: string }[]>;
  summarizeContext: (context: string, sourceLabel: string) => Promise<{ summary: string | null; error: string | null }>;
  getDisplayNames: () => Promise<Record<string, string>>;
  discoverExternal: () => Promise<ExternalSession[]>;
  adoptExternal: (sessionUuid: string, cwd: string) => Promise<SessionInfo>;
  scanProjects: () => Promise<DiscoveredProject[]>;
  scanSessions: (encodedPath: string) => Promise<DiscoveredSession[]>;
  getPinnedProjects: () => Promise<PinnedProject[]>;
  updatePinnedProjects: (pins: PinnedProject[]) => Promise<void>;
  resolveProjectPath: (encodedPath: string) => Promise<string | null>;
  setTheme: (theme: 'dark' | 'light') => void;
  getShells: () => Promise<DetectedShell[]>;
  getDefaultShell: () => Promise<string | null>;
  setDefaultShell: (id: string) => Promise<void>;
  clipboardWriteText: (text: string) => void;
  clipboardReadText: () => string;
  gitStatus: (sessionId: string) => Promise<GitStatusResult>;
  gitFileDiff: (sessionId: string, filePath: string, staged: boolean) => Promise<GitFileDiffResult>;
  gitSaveFile: (sessionId: string, filePath: string, content: string) => Promise<void>;
  gitStageFile: (sessionId: string, filePath: string) => Promise<void>;
  gitUnstageFile: (sessionId: string, filePath: string) => Promise<void>;
}

declare global {
  interface Window {
    agentPlex: AgentPlexAPI;
  }
}

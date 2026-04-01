import type { CliTool, DetectedShell, SessionInfo, SessionStatus, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo, ExternalSession, DiscoveredProject, DiscoveredSession, PinnedProject, GitStatusResult, GitFileDiffResult, GitLogEntry, GitBranchInfo, GitCommandResult, DrawingData, AppPreferences, SyncStatusInfo } from '../shared/ipc-channels';

export interface AgentPlexAPI {
  platform: string;
  createSession: (cwd?: string, cli?: CliTool, resumeSessionId?: string) => Promise<SessionInfo>;
  pickDirectory: () => Promise<string | null>;
  writeSession: (id: string, data: string) => void;
  resizeSession: (id: string, cols: number, rows: number) => void;
  killSession: (id: string) => Promise<void>;
  listSessions: () => Promise<SessionInfo[]>;
  getSessionBuffer: (id: string) => Promise<string>;
  getSessionCwd: (id: string) => Promise<string | null>;
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
  summarizeContext: (sessionId: string, sourceLabel: string) => Promise<{ summary: string | null; error: string | null }>;
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
  openPath: (path: string) => Promise<void>;
  clipboardWriteText: (text: string) => void;
  clipboardReadText: () => string;
  openSettings: () => Promise<void>;
  openProjectConfig: (cwd: string) => Promise<void>;
  gitStatus: (sessionId: string) => Promise<GitStatusResult>;
  gitFileDiff: (sessionId: string, filePath: string, staged: boolean) => Promise<GitFileDiffResult>;
  gitSaveFile: (sessionId: string, filePath: string, content: string) => Promise<void>;
  gitStageFile: (sessionId: string, filePath: string) => Promise<void>;
  gitUnstageFile: (sessionId: string, filePath: string) => Promise<void>;
  gitCommit: (sessionId: string, message: string) => Promise<GitCommandResult>;
  gitPush: (sessionId: string) => Promise<GitCommandResult>;
  gitPull: (sessionId: string) => Promise<GitCommandResult>;
  gitLog: (sessionId: string) => Promise<GitLogEntry[]>;
  gitBranchInfo: (sessionId: string) => Promise<GitBranchInfo>;
  canvasLoad: () => Promise<DrawingData>;
  canvasSave: (data: DrawingData) => Promise<void>;

  // Settings sync
  syncSetupAuto: () => Promise<SyncStatusInfo>;
  syncSetup: (repoUrl: string) => Promise<SyncStatusInfo>;
  syncGetGitHubUser: () => Promise<{ username: string; host: string } | null>;
  syncGhLogin: (host?: string) => Promise<{ status: string; code?: string; error?: string }>;
  onGhLoginProgress: (callback: (progress: { status: string; code?: string }) => void) => () => void;
  syncPush: () => Promise<SyncStatusInfo>;
  syncPull: () => Promise<SyncStatusInfo>;
  syncDisconnect: () => Promise<void>;
  syncStatus: () => Promise<SyncStatusInfo>;
  syncListProfiles: () => Promise<string[]>;
  syncCreateProfile: (name: string) => Promise<void>;
  syncSwitchProfile: (name: string) => Promise<void>;
  syncRenameProfile: (oldName: string, newName: string) => Promise<void>;
  syncDeleteProfile: (name: string) => Promise<void>;
  syncActiveProfile: () => Promise<string>;
  onSyncStatusChanged: (callback: (status: SyncStatusInfo) => void) => () => void;

  // Expanded settings
  getAllSettings: () => Promise<AppPreferences>;
  updateSettings: (settings: Partial<AppPreferences>) => Promise<void>;
  onSettingsChanged: (callback: (settings: AppPreferences) => void) => () => void;
}

declare global {
  interface Window {
    agentPlex: AgentPlexAPI;
  }
}

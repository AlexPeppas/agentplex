import { contextBridge, ipcRenderer, clipboard } from 'electron';
import { IPC, SessionStatus } from '../shared/ipc-channels';
import type { CliTool, DetectedShell, SessionInfo, SubagentInfo, PlanInfo, TaskInfo, TaskUpdateInfo, TaskListInfo, ExternalSession, DiscoveredProject, DiscoveredSession, PinnedProject, GitStatusResult, GitFileDiffResult, GitLogEntry, GitBranchInfo, GitCommandResult } from '../shared/ipc-channels';

const api = {
  platform: process.platform,

  createSession: (cwd?: string, cli?: CliTool, resumeSessionId?: string): Promise<SessionInfo> => {
    return ipcRenderer.invoke(IPC.SESSION_CREATE, { cwd, cli, resumeSessionId });
  },

  pickDirectory: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR);
  },

  writeSession: (id: string, data: string): void => {
    ipcRenderer.send(IPC.SESSION_WRITE, { id, data });
  },

  resizeSession: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send(IPC.SESSION_RESIZE, { id, cols, rows });
  },

  killSession: (id: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.SESSION_KILL, { id });
  },

  listSessions: (): Promise<SessionInfo[]> => {
    return ipcRenderer.invoke(IPC.SESSION_LIST);
  },

  getSessionBuffer: (id: string): Promise<string> => {
    return ipcRenderer.invoke(IPC.SESSION_GET_BUFFER, { id });
  },

  onSessionData: (callback: (data: { id: string; data: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.SESSION_DATA, handler);
    return () => ipcRenderer.removeListener(IPC.SESSION_DATA, handler);
  },

  onSessionStatus: (callback: (data: { id: string; status: SessionStatus }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; status: SessionStatus }) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.SESSION_STATUS, handler);
    return () => ipcRenderer.removeListener(IPC.SESSION_STATUS, handler);
  },

  onSessionExit: (callback: (data: { id: string; exitCode: number }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { id: string; exitCode: number }) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.SESSION_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.SESSION_EXIT, handler);
  },

  onSubagentSpawn: (callback: (data: SubagentInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: SubagentInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.SUBAGENT_SPAWN, handler);
    return () => ipcRenderer.removeListener(IPC.SUBAGENT_SPAWN, handler);
  },

  onSubagentComplete: (callback: (data: SubagentInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: SubagentInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.SUBAGENT_COMPLETE, handler);
    return () => ipcRenderer.removeListener(IPC.SUBAGENT_COMPLETE, handler);
  },

  onPlanEnter: (callback: (data: PlanInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: PlanInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.PLAN_ENTER, handler);
    return () => ipcRenderer.removeListener(IPC.PLAN_ENTER, handler);
  },

  onPlanExit: (callback: (data: { sessionId: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.PLAN_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC.PLAN_EXIT, handler);
  },

  onTaskCreate: (callback: (data: TaskInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.TASK_CREATE, handler);
    return () => ipcRenderer.removeListener(IPC.TASK_CREATE, handler);
  },

  onTaskUpdate: (callback: (data: TaskUpdateInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskUpdateInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.TASK_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC.TASK_UPDATE, handler);
  },

  onTaskList: (callback: (data: TaskListInfo) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskListInfo) => {
      callback(payload);
    };
    ipcRenderer.on(IPC.TASK_LIST, handler);
    return () => ipcRenderer.removeListener(IPC.TASK_LIST, handler);
  },

  updateSessionState: (sessionId: string, displayName: string): void => {
    ipcRenderer.send(IPC.SESSION_UPDATE_STATE, { sessionId, displayName });
  },

  restoreAllSessions: (): Promise<{ info: SessionInfo; displayName: string }[]> => {
    return ipcRenderer.invoke(IPC.SESSION_RESTORE_ALL);
  },

  summarizeContext: (context: string, sourceLabel: string): Promise<{ summary: string | null; error: string | null }> => {
    return ipcRenderer.invoke(IPC.SUMMARIZE_CONTEXT, { context, sourceLabel });
  },

  getDisplayNames: (): Promise<Record<string, string>> => {
    return ipcRenderer.invoke(IPC.DISPLAY_NAMES_GET);
  },

  discoverExternal: (): Promise<ExternalSession[]> => {
    return ipcRenderer.invoke(IPC.DISCOVER_EXTERNAL);
  },

  adoptExternal: (sessionUuid: string, cwd: string): Promise<SessionInfo> => {
    return ipcRenderer.invoke(IPC.ADOPT_EXTERNAL, { sessionUuid, cwd });
  },

  scanProjects: (): Promise<DiscoveredProject[]> => {
    return ipcRenderer.invoke(IPC.LAUNCHER_SCAN_PROJECTS);
  },

  scanSessions: (encodedPath: string): Promise<DiscoveredSession[]> => {
    return ipcRenderer.invoke(IPC.LAUNCHER_SCAN_SESSIONS, { encodedPath });
  },

  getPinnedProjects: (): Promise<PinnedProject[]> => {
    return ipcRenderer.invoke(IPC.LAUNCHER_GET_PINS);
  },

  updatePinnedProjects: (pins: PinnedProject[]): Promise<void> => {
    return ipcRenderer.invoke(IPC.LAUNCHER_UPDATE_PINS, { pins });
  },

  resolveProjectPath: (encodedPath: string): Promise<string | null> => {
    return ipcRenderer.invoke(IPC.LAUNCHER_RESOLVE_PATH, { encodedPath });
  },

  setTheme: (theme: 'dark' | 'light'): void => {
    ipcRenderer.send(IPC.THEME_CHANGE, { theme });
  },

  getShells: (): Promise<DetectedShell[]> => {
    return ipcRenderer.invoke(IPC.SHELL_LIST);
  },

  getDefaultShell: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC.SETTINGS_GET_DEFAULT_SHELL);
  },

  setDefaultShell: (id: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.SETTINGS_SET_DEFAULT_SHELL, { id });
  },

  openPath: (path: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, { path });
  },

  clipboardWriteText: (text: string): void => {
    clipboard.writeText(text);
  },

  clipboardReadText: (): string => {
    return clipboard.readText();
  },

  gitStatus: (sessionId: string): Promise<GitStatusResult> => {
    return ipcRenderer.invoke(IPC.GIT_STATUS, { sessionId });
  },

  gitFileDiff: (sessionId: string, filePath: string, staged: boolean): Promise<GitFileDiffResult> => {
    return ipcRenderer.invoke(IPC.GIT_FILE_DIFF, { sessionId, filePath, staged });
  },

  gitSaveFile: (sessionId: string, filePath: string, content: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.GIT_SAVE_FILE, { sessionId, filePath, content });
  },

  gitStageFile: (sessionId: string, filePath: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.GIT_STAGE_FILE, { sessionId, filePath });
  },

  gitUnstageFile: (sessionId: string, filePath: string): Promise<void> => {
    return ipcRenderer.invoke(IPC.GIT_UNSTAGE_FILE, { sessionId, filePath });
  },

  gitCommit: (sessionId: string, message: string): Promise<GitCommandResult> => {
    return ipcRenderer.invoke(IPC.GIT_COMMIT, { sessionId, message });
  },

  gitPush: (sessionId: string): Promise<GitCommandResult> => {
    return ipcRenderer.invoke(IPC.GIT_PUSH, { sessionId });
  },

  gitPull: (sessionId: string): Promise<GitCommandResult> => {
    return ipcRenderer.invoke(IPC.GIT_PULL, { sessionId });
  },

  gitLog: (sessionId: string): Promise<GitLogEntry[]> => {
    return ipcRenderer.invoke(IPC.GIT_LOG, { sessionId });
  },

  gitBranchInfo: (sessionId: string): Promise<GitBranchInfo> => {
    return ipcRenderer.invoke(IPC.GIT_BRANCH_INFO, { sessionId });
  },
};

contextBridge.exposeInMainWorld('agentPlex', api);

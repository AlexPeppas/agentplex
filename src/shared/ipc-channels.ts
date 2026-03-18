export type CliTool = 'claude' | 'codex' | 'copilot' | 'claude-resume' | 'powershell' | 'bash';

export const CLI_TOOLS: { id: CliTool; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'gh copilot' },
];

export const SHELL_TOOLS: { id: CliTool; label: string; command: string }[] = [
  { id: 'powershell', label: 'PowerShell', command: '' },
  { id: 'bash', label: 'Bash', command: '' },
];

export const RESUME_TOOL: { id: CliTool; label: string; command: string } = {
  id: 'claude-resume', label: 'Claude Resume', command: 'claude --resume',
};

export enum SessionStatus {
  Running = 'running',
  Idle = 'idle',
  WaitingForInput = 'waiting-for-input',
  Killed = 'killed',
}

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
}

export interface SubagentInfo {
  sessionId: string;
  subagentId: string;
  description: string;
}

export interface PlanInfo {
  sessionId: string;
  planTitle: string;
}

export interface TaskInfo {
  sessionId: string;
  taskNumber: number;
  description: string;
}

export interface TaskUpdateInfo {
  sessionId: string;
  taskNumber: number;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface TaskListInfo {
  sessionId: string;
  tasks: { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }[];
}

export const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_KILL: 'session:kill',
  SESSION_LIST: 'session:list',
  SESSION_GET_BUFFER: 'session:getBuffer',
  SESSION_DATA: 'session:data',
  SESSION_STATUS: 'session:status',
  SESSION_EXIT: 'session:exit',
  DIALOG_OPEN_DIR: 'dialog:openDirectory',
  SUBAGENT_SPAWN: 'subagent:spawn',
  SUBAGENT_COMPLETE: 'subagent:complete',
  PLAN_ENTER: 'plan:enter',
  PLAN_EXIT: 'plan:exit',
  TASK_CREATE: 'task:create',
  TASK_UPDATE: 'task:update',
  TASK_LIST: 'task:list',
  THEME_CHANGE: 'theme:change',
  SUMMARIZE_CONTEXT: 'summarize:context',
  DISPLAY_NAMES_LOAD: 'displayNames:load',
  DISPLAY_NAMES_SAVE: 'displayNames:save',
  SESSION_RESTORE_ALL: 'session:restoreAll',
  SESSION_UPDATE_STATE: 'session:updateState',
} as const;

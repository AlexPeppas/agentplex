export type CliTool = 'claude' | 'codex' | 'copilot' | 'claude-resume' | (string & {});

export const CLI_TOOLS: { id: CliTool; label: string; command: string }[] = [
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'gh copilot' },
];

export interface DetectedShell {
  id: string;
  label: string;
  path: string;
  type: 'powershell' | 'bash';
}

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
  cwd: string;
  cli: CliTool;
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

export interface ExternalSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  name?: string;
}

export interface DiscoveredProject {
  encodedPath: string;
  realPath: string;
  dirName: string;
  sessionCount: number;
  lastActivity: string;
  isPinned: boolean;
}

export interface DiscoveredSession {
  sessionId: string;
  projectPath: string;
  customTitle: string | null;
  firstUserMessage: string | null;
  gitBranch: string | null;
  lastTimestamp: string | null;
}

export interface PinnedProject {
  path: string;
  label?: string;
}

export interface ClaudeConfig {
  command: string;
  flags: string[];
}

export interface GitChangedFile {
  path: string;
  status: 'M' | 'A' | 'D' | 'R' | 'U' | '?' | string;
  staged: boolean;
}

export interface GitStatusResult {
  isRepo: boolean;
  files: GitChangedFile[];
  repoRoot: string;
}

export interface GitFileDiffResult {
  original: string;
  modified: string;
  language: string;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitBranchInfo {
  current: string;
  tracking: string | null;
  ahead: number;
  behind: number;
}

export interface GitCommandResult {
  success: boolean;
  output: string;
}

// ── Drawing canvas types ─────────────────────────────────────────────────────

export interface DrawingElement {
  id: string;
  type: 'stroke' | 'eraser' | 'rect' | 'ellipse' | 'line' | 'text';
  /** Pen/eraser: array of [x,y] points */
  points?: [number, number][];
  /** Shapes: bounding box */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Line: endpoints */
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  /** Text element */
  text?: string;
  fontSize?: number;
  color: string;
  strokeWidth: number;
}

export interface DrawingData {
  elements: DrawingElement[];
  version: number;
}

export const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_KILL: 'session:kill',
  SESSION_LIST: 'session:list',
  SESSION_GET_BUFFER: 'session:getBuffer',
  SESSION_GET_CWD: 'session:getCwd',
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
  DISPLAY_NAMES_GET: 'displayNames:get',
  SESSION_RESTORE_ALL: 'session:restoreAll',
  SESSION_UPDATE_STATE: 'session:updateState',
  DISCOVER_EXTERNAL: 'session:discoverExternal',
  ADOPT_EXTERNAL: 'session:adoptExternal',
  LAUNCHER_SCAN_PROJECTS: 'launcher:scanProjects',
  LAUNCHER_SCAN_SESSIONS: 'launcher:scanSessions',
  LAUNCHER_GET_PINS: 'launcher:getPins',
  LAUNCHER_UPDATE_PINS: 'launcher:updatePins',
  LAUNCHER_RESOLVE_PATH: 'launcher:resolvePath',
  SHELL_LIST: 'shell:list',
  SETTINGS_GET_DEFAULT_SHELL: 'settings:getDefaultShell',
  SETTINGS_SET_DEFAULT_SHELL: 'settings:setDefaultShell',
  SETTINGS_OPEN_GLOBAL: 'settings:openGlobal',
  SETTINGS_OPEN_PROJECT: 'settings:openProject',
  SHELL_OPEN_PATH: 'shell:openPath',
  GIT_STATUS: 'git:status',
  GIT_FILE_DIFF: 'git:fileDiff',
  GIT_SAVE_FILE: 'git:saveFile',
  GIT_STAGE_FILE: 'git:stageFile',
  GIT_UNSTAGE_FILE: 'git:unstageFile',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_LOG: 'git:log',
  GIT_BRANCH_INFO: 'git:branchInfo',
  CANVAS_LOAD: 'canvas:load',
  CANVAS_SAVE: 'canvas:save',
} as const;

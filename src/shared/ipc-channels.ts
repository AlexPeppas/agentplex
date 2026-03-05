export enum SessionStatus {
  Running = 'running',
  Idle = 'idle',
  Killed = 'killed',
}

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
}

export const IPC = {
  SESSION_CREATE: 'session:create',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_KILL: 'session:kill',
  SESSION_LIST: 'session:list',
  SESSION_DATA: 'session:data',
  SESSION_STATUS: 'session:status',
  SESSION_EXIT: 'session:exit',
  DIALOG_OPEN_DIR: 'dialog:openDirectory',
} as const;

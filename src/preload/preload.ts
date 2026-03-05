import { contextBridge, ipcRenderer } from 'electron';
import { IPC, SessionInfo, SessionStatus } from '../shared/ipc-channels';

const api = {
  createSession: (cwd?: string): Promise<SessionInfo> => {
    return ipcRenderer.invoke(IPC.SESSION_CREATE, { cwd });
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
};

contextBridge.exposeInMainWorld('agentField', api);

import { ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';

export function registerIpcHandlers() {
  ipcMain.handle(IPC.SESSION_CREATE, () => {
    return sessionManager.create();
  });

  ipcMain.on(IPC.SESSION_WRITE, (_event, { id, data }: { id: string; data: string }) => {
    sessionManager.write(id, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    sessionManager.resize(id, cols, rows);
  });

  ipcMain.handle(IPC.SESSION_KILL, (_event, { id }: { id: string }) => {
    sessionManager.kill(id);
  });

  ipcMain.handle(IPC.SESSION_LIST, () => {
    return sessionManager.list();
  });
}

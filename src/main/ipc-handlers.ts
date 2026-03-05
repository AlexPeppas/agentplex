import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';

export function registerIpcHandlers() {
  ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd }: { cwd?: string } = {}) => {
    return sessionManager.create(cwd);
  });

  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: 'Select working directory for Claude session',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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

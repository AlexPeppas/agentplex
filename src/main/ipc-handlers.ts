import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';

export function registerIpcHandlers() {
  ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd, cli }: { cwd?: string; cli?: string } = {}) => {
    return sessionManager.create(cwd, (cli as any) || 'claude');
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

  ipcMain.handle(IPC.SESSION_GET_BUFFER, (_event, { id }: { id: string }) => {
    return sessionManager.getBuffer(id);
  });

  ipcMain.handle(IPC.SUMMARIZE_CONTEXT, async (_event, { context, sourceLabel }: { context: string; sourceLabel: string }) => {
    try {
      // Lazy require to avoid top-level import issues with bundler
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic();
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: `You are summarizing the recent activity of an AI coding assistant session called "${sourceLabel}". This summary will be sent to another AI assistant session so it can understand what the source session has been working on.

Summarize the following terminal output concisely. Focus on:
- What task/goal the session is working on
- Key decisions made or approaches taken
- Current state (what's done, what's in progress, any blockers)
- Any important file paths, function names, or technical details

Keep it under 2000 tokens. Be direct and factual.

<terminal_output>
${context}
</terminal_output>`,
        }],
      });
      const text = response.content.find((b: any) => b.type === 'text');
      return { summary: text ? (text as any).text : context, error: null };
    } catch (err: any) {
      return { summary: null, error: err.message || 'Summarization failed' };
    }
  });

  const THEME_COLORS = {
    dark: { titleBar: '#1e1c18', symbol: '#ece4d8', bg: '#262420' },
    light: { titleBar: '#ebe5da', symbol: '#3a3428', bg: '#f5f0e8' },
  };

  ipcMain.on(IPC.THEME_CHANGE, (_event, { theme }: { theme: 'dark' | 'light' }) => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    const colors = THEME_COLORS[theme];
    win.setTitleBarOverlay({
      color: colors.titleBar,
      symbolColor: colors.symbol,
    });
    win.setBackgroundColor(colors.bg);
  });
}

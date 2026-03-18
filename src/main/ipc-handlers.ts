import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';
import * as path from 'path';
import * as fs from 'fs';
import { homedir } from 'os';

const AGENTPLEX_DIR = path.join(homedir(), '.agentplex');
const DISPLAY_NAMES_PATH = path.join(AGENTPLEX_DIR, 'displayNames.json');

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
    console.log(`[summarize] Request for "${sourceLabel}" (${context.length} chars)`);

    const apiKey = process.env.AGENTPLEX_API_KEY;
    if (!apiKey) {
      console.warn('[summarize] AGENTPLEX_API_KEY not set — skipping summarization');
      return { summary: null, error: 'AGENTPLEX_API_KEY not set. Set it to enable cross-session summarization.' };
    }

    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      console.log('[summarize] Calling Haiku...');
      const client = new Anthropic({ apiKey });
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
      const summary = text ? (text as any).text : context;
      console.log(`[summarize] Success — ${summary.length} chars, usage: ${response.usage?.input_tokens}in/${response.usage?.output_tokens}out`);
      return { summary, error: null };
    } catch (err: any) {
      console.error('[summarize] Failed:', err.message || err);
      return { summary: null, error: err.message || 'Summarization failed' };
    }
  });

  ipcMain.on(IPC.SESSION_UPDATE_STATE, (_event, { sessionId, displayName }: { sessionId: string; displayName: string }) => {
    sessionManager.updateDisplayName(sessionId, displayName);
  });

  ipcMain.handle(IPC.SESSION_RESTORE_ALL, () => {
    return sessionManager.restoreAll();
  });

  ipcMain.handle(IPC.DISPLAY_NAMES_LOAD, () => {
    try {
      const data = fs.readFileSync(DISPLAY_NAMES_PATH, 'utf-8');
      return JSON.parse(data) as Record<string, string>;
    } catch {
      return {};
    }
  });

  ipcMain.on(IPC.DISPLAY_NAMES_SAVE, (_event, { displayNames }: { displayNames: Record<string, string> }) => {
    try {
      fs.mkdirSync(AGENTPLEX_DIR, { recursive: true });
      fs.writeFileSync(DISPLAY_NAMES_PATH, JSON.stringify(displayNames, null, 2));
    } catch (err: any) {
      console.error('[displayNames] Failed to save:', err.message);
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

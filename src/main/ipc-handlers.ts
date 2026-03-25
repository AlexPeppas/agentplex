import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC, CLI_TOOLS, SHELL_TOOLS, RESUME_TOOL, type CliTool } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';
import * as fs from 'fs';
import * as path from 'path';

const VALID_CLI_IDS = new Set<string>([
  ...CLI_TOOLS.map((t) => t.id),
  ...SHELL_TOOLS.map((t) => t.id),
  RESUME_TOOL.id,
]);

const MAX_CONTEXT_LENGTH = 100_000;

export function registerIpcHandlers() {
  ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd, cli }: { cwd?: string; cli?: string } = {}) => {
    const safeCli: CliTool = (cli && VALID_CLI_IDS.has(cli) ? cli : 'claude') as CliTool;
    return sessionManager.create(cwd, safeCli);
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
    if (typeof id !== 'string' || typeof data !== 'string') return;
    sessionManager.write(id, data);
  });

  ipcMain.on(IPC.SESSION_RESIZE, (_event, { id, cols, rows }: { id: string; cols: number; rows: number }) => {
    if (typeof id !== 'string') return;
    const safeCols = Math.max(1, Math.min(500, Math.floor(Number(cols) || 80)));
    const safeRows = Math.max(1, Math.min(200, Math.floor(Number(rows) || 24)));
    sessionManager.resize(id, safeCols, safeRows);
  });

  ipcMain.handle(IPC.SESSION_KILL, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return;
    sessionManager.kill(id);
  });

  ipcMain.handle(IPC.SESSION_LIST, () => {
    return sessionManager.list();
  });

  ipcMain.handle(IPC.SESSION_GET_BUFFER, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return '';
    return sessionManager.getBuffer(id);
  });

  ipcMain.handle(IPC.SUMMARIZE_CONTEXT, async (_event, { context, sourceLabel }: { context: string; sourceLabel: string }) => {
    if (typeof context !== 'string' || typeof sourceLabel !== 'string') {
      return { summary: null, error: 'Invalid parameters' };
    }
    const safeContext = context.slice(0, MAX_CONTEXT_LENGTH);
    const safeLabel = sourceLabel.slice(0, 200);
    console.log(`[summarize] Request for "${safeLabel}" (${safeContext.length} chars)`);

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
          content: `You are summarizing the recent activity of an AI coding assistant session called "${safeLabel}". This summary will be sent to another AI assistant session so it can understand what the source session has been working on.

Summarize the following terminal output concisely. Focus on:
- What task/goal the session is working on
- Key decisions made or approaches taken
- Current state (what's done, what's in progress, any blockers)
- Any important file paths, function names, or technical details

Keep it under 2000 tokens. Be direct and factual.

<terminal_output>
${safeContext}
</terminal_output>`,
        }],
      });
      const text = response.content.find((b: any) => b.type === 'text');
      const summary = text ? (text as any).text : safeContext;
      console.log(`[summarize] Success — ${summary.length} chars, usage: ${response.usage?.input_tokens}in/${response.usage?.output_tokens}out`);
      return { summary, error: null };
    } catch (err: any) {
      console.error('[summarize] Failed:', err.message || err);
      return { summary: null, error: err.message || 'Summarization failed' };
    }
  });

  ipcMain.on(IPC.SESSION_UPDATE_STATE, (_event, { sessionId, displayName }: { sessionId: string; displayName: string }) => {
    if (typeof sessionId !== 'string' || typeof displayName !== 'string') return;
    sessionManager.updateDisplayName(sessionId, displayName.slice(0, 200));
  });

  ipcMain.handle(IPC.SESSION_RESTORE_ALL, () => {
    return sessionManager.restoreAll();
  });

  ipcMain.handle(IPC.DISPLAY_NAMES_GET, () => {
    return sessionManager.getDisplayNames();
  });

  const THEME_COLORS: Record<string, { titleBar: string; symbol: string; bg: string }> = {
    dark: { titleBar: '#1e1c18', symbol: '#ece4d8', bg: '#262420' },
    light: { titleBar: '#ebe5da', symbol: '#3a3428', bg: '#f5f0e8' },
  };

  ipcMain.on(IPC.THEME_CHANGE, (_event, { theme }: { theme: string }) => {
    const colors = THEME_COLORS[theme];
    if (!colors) return;
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    win.setTitleBarOverlay({
      color: colors.titleBar,
      symbolColor: colors.symbol,
    });
    win.setBackgroundColor(colors.bg);
  });

  ipcMain.handle(IPC.SEARCH_FILES, async (_event, { query, cwd }: { query: string; cwd: string }) => {
    if (!query || !cwd) return [];
    const results: { file: string; line: number; text: string }[] = [];
    const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.vite', '.next', '__pycache__']);
    const MAX_RESULTS = 100;
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB

    function walk(dir: string) {
      if (results.length >= MAX_RESULTS) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= MAX_RESULTS) return;
        if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(full);
            if (stat.size > MAX_FILE_SIZE) continue;
            const content = fs.readFileSync(full, 'utf-8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              if (results.length >= MAX_RESULTS) break;
              if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                results.push({
                  file: path.relative(cwd, full).replace(/\\/g, '/'),
                  line: i + 1,
                  text: lines[i].trim().slice(0, 200),
                });
              }
            }
          } catch {
            // skip binary or unreadable files
          }
        }
      }
    }

    walk(cwd);
    return results;
  });
}

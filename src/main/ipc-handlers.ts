import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC, CLI_TOOLS, RESUME_TOOL, type CliTool, type PinnedProject } from '../shared/ipc-channels';
import { sessionManager } from './session-manager';
import { detectShells, getCachedShells } from './shell-detector';
import { getDefaultShellId, setDefaultShellId } from './settings-manager';
import { scanProjects, scanSessionsForProject, getPinnedProjects, updatePinnedProjects, resolveProjectPath } from './claude-session-scanner';

const VALID_CLI_IDS = new Set<string>([
  ...CLI_TOOLS.map((t) => t.id),
  RESUME_TOOL.id,
]);

function isValidCli(id: string): boolean {
  return VALID_CLI_IDS.has(id) || getCachedShells().some((s) => s.id === id);
}

const MAX_CONTEXT_LENGTH = 100_000;

export function registerIpcHandlers() {
  ipcMain.handle(IPC.SESSION_CREATE, (_event, { cwd, cli, resumeSessionId }: { cwd?: string; cli?: string; resumeSessionId?: string } = {}) => {
    const safeCli: CliTool = (cli && isValidCli(cli) ? cli : 'claude') as CliTool;
    return sessionManager.create(cwd, safeCli, resumeSessionId);
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

  ipcMain.handle(IPC.DISCOVER_EXTERNAL, () => {
    return sessionManager.discoverExternal();
  });

  ipcMain.handle(IPC.ADOPT_EXTERNAL, (_event, { sessionUuid, cwd }: { sessionUuid: string; cwd: string }) => {
    if (typeof sessionUuid !== 'string' || typeof cwd !== 'string') {
      throw new Error('Invalid parameters');
    }
    return sessionManager.adoptExternal(sessionUuid, cwd);
  });

  ipcMain.handle(IPC.DISPLAY_NAMES_GET, () => {
    return sessionManager.getDisplayNames();
  });

  const THEME_COLORS: Record<string, { titleBar: string; symbol: string; bg: string }> = {
    dark: { titleBar: '#1e1c18', symbol: '#ece4d8', bg: '#262420' },
    light: { titleBar: '#ebe5da', symbol: '#3a3428', bg: '#f5f0e8' },
  };

  ipcMain.handle(IPC.LAUNCHER_SCAN_PROJECTS, async () => {
    console.log('[launcher] scanProjects called');
    try {
      const result = await scanProjects();
      console.log('[launcher] scanProjects done:', result.length, 'projects');
      return result;
    } catch (err) {
      console.error('[launcher] scanProjects error:', err);
      return [];
    }
  });

  ipcMain.handle(IPC.LAUNCHER_SCAN_SESSIONS, async (_event, { encodedPath }: { encodedPath: string }) => {
    if (typeof encodedPath !== 'string') return [];
    return scanSessionsForProject(encodedPath);
  });

  ipcMain.handle(IPC.LAUNCHER_GET_PINS, () => {
    return getPinnedProjects();
  });

  ipcMain.handle(IPC.LAUNCHER_UPDATE_PINS, (_event, { pins }: { pins: PinnedProject[] }) => {
    if (!Array.isArray(pins)) return;
    updatePinnedProjects(pins);
  });

  ipcMain.handle(IPC.LAUNCHER_RESOLVE_PATH, async (_event, { encodedPath }: { encodedPath: string }) => {
    if (typeof encodedPath !== 'string') return null;
    return resolveProjectPath(encodedPath);
  });

  ipcMain.on(IPC.THEME_CHANGE, (_event, { theme }: { theme: string }) => {
    const colors = THEME_COLORS[theme];
    if (!colors) return;
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return;
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({
        color: colors.titleBar,
        symbolColor: colors.symbol,
      });
    }
    win.setBackgroundColor(colors.bg);
  });

  ipcMain.handle(IPC.SHELL_LIST, async () => {
    return await detectShells();
  });

  ipcMain.handle(IPC.SETTINGS_GET_DEFAULT_SHELL, () => {
    return getDefaultShellId() || null;
  });

  ipcMain.handle(IPC.SETTINGS_SET_DEFAULT_SHELL, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return;
    if (!getCachedShells().some((s) => s.id === id)) return;
    setDefaultShellId(id);
  });
}

import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { IPC, CLI_TOOLS, RESUME_TOOL, type CliTool, type PinnedProject, type DrawingData, type WorkspaceTemplate } from '../shared/ipc-channels';
import { ensureGlobalConfig, ensureProjectConfig } from './config-loader';
import { sessionManager } from './session-manager';
import { detectShells, getCachedShells } from './shell-detector';
import { getDefaultShellId, setDefaultShellId } from './settings-manager';
import { scanProjects, scanSessionsForProject, getPinnedProjects, updatePinnedProjects, resolveProjectPath } from './claude-session-scanner';
import { getGitStatus, getFileDiff, saveFile, stageFile, unstageFile, stageAll, unstageAll, gitCommit, gitPush, gitPull, gitLog, gitBranchInfo } from './git-operations';

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

  ipcMain.handle(IPC.SESSION_GET_CWD, (_event, { id }: { id: string }) => {
    if (typeof id !== 'string') return null;
    return sessionManager.getCwd(id);
  });

  ipcMain.handle(IPC.SUMMARIZE_CONTEXT, async (_event, { sessionId, sourceLabel }: { sessionId: string; sourceLabel: string }) => {
    if (typeof sessionId !== 'string' || typeof sourceLabel !== 'string') {
      return { summary: null, error: 'Invalid parameters' };
    }
    const safeLabel = sourceLabel.slice(0, 200);

    // Read the full conversation from the JSONL file instead of the terminal buffer
    const jsonlPath = sessionManager.getJsonlPath(sessionId);
    let conversation = '';

    if (jsonlPath) {
      try {
        const raw = fs.readFileSync(jsonlPath, 'utf-8');
        const messages: string[] = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            const type = record.type;
            const content = record.message?.content;
            if (type !== 'user' && type !== 'assistant') continue;

            if (type === 'user') {
              if (typeof content === 'string') {
                messages.push(`[User]\n${content}`);
              } else if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === 'text' && block.text) {
                    messages.push(`[User]\n${block.text}`);
                  }
                }
              }
            } else if (type === 'assistant' && Array.isArray(content)) {
              for (const block of content) {
                if (block.type === 'text' && block.text) {
                  messages.push(`[Assistant]\n${block.text}`);
                } else if (block.type === 'tool_use') {
                  const toolName = block.name || 'tool';
                  const desc = block.input?.description || block.input?.command || block.input?.pattern || '';
                  const preview = typeof desc === 'string' ? desc.slice(0, 200) : '';
                  messages.push(`[Tool: ${toolName}]${preview ? ' ' + preview : ''}`);
                }
              }
            }
          } catch { /* skip malformed line */ }
        }
        conversation = messages.join('\n\n');
      } catch (err: any) {
        console.warn(`[summarize] Could not read JSONL: ${err.message}`);
      }
    }

    // Fall back to terminal buffer if JSONL is empty/unavailable
    if (!conversation) {
      const buffer = sessionManager.getBuffer(sessionId);
      if (buffer) {
        const { stripAnsi } = await import('../shared/ansi-strip');
        conversation = stripAnsi(buffer).slice(-MAX_CONTEXT_LENGTH);
      }
    }

    if (!conversation) {
      return { summary: null, error: 'No conversation data available' };
    }

    // Cap at MAX_CONTEXT_LENGTH for the API call
    const safeContext = conversation.length > MAX_CONTEXT_LENGTH
      ? conversation.slice(-MAX_CONTEXT_LENGTH)
      : conversation;

    console.log(`[summarize] Request for "${safeLabel}" — ${safeContext.length} chars from JSONL`);

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
          content: `You are summarizing the full conversation of an AI coding assistant session called "${safeLabel}". This summary will be sent to another AI assistant session so it can understand what the source session has been working on.

Summarize the following conversation concisely. Focus on:
- What task/goal the session is working on
- Key decisions made or approaches taken
- Current state (what's done, what's in progress, any blockers)
- Any important file paths, function names, or technical details

Keep it under 2000 tokens. Be direct and factual.

<conversation>
${safeContext}
</conversation>`,
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

  ipcMain.handle(IPC.SETTINGS_OPEN_GLOBAL, async () => {
    const configPath = ensureGlobalConfig();
    const error = await shell.openPath(configPath);
    if (error) {
      dialog.showErrorBox('Failed to open global settings', error);
    }
  });

  ipcMain.handle(IPC.SETTINGS_OPEN_PROJECT, async (_event, { cwd }: { cwd: string }) => {
    if (typeof cwd !== 'string') return;
    const configPath = ensureProjectConfig(cwd);
    const error = await shell.openPath(configPath);
    if (error) {
      dialog.showErrorBox('Failed to open project settings', error);
    }
  });

  ipcMain.handle(IPC.SHELL_OPEN_PATH, async (_event, { path: reqPath }: { path: string }) => {
    if (typeof reqPath !== 'string') return;

    // Security: only allow opening directories that are known session cwds.
    // This prevents the renderer from opening arbitrary files/executables.
    const resolved = path.resolve(reqPath);
    const knownCwds = new Set(
      sessionManager.list().map((s) => path.resolve(s.cwd))
    );

    if (!knownCwds.has(resolved)) {
      console.warn('[openPath] Blocked — not a known session cwd:', resolved);
      throw new Error('Path is not a known session working directory');
    }

    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        throw new Error('Path is not a directory');
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new Error('Path does not exist', { cause: err });
      throw err;
    }

    const error = await shell.openPath(resolved);
    if (error) {
      console.error('Failed to open path:', error);
      throw new Error(error);
    }
  });

  // ── Git operations ──────────────────────────────────────────

  ipcMain.handle(IPC.GIT_STATUS, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') return { isRepo: false, files: [], repoRoot: '' };
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) return { isRepo: false, files: [], repoRoot: '' };
    return getGitStatus(cwd);
  });

  ipcMain.handle(IPC.GIT_FILE_DIFF, async (_event, { sessionId, filePath, staged }: { sessionId: string; filePath: string; staged: boolean }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return getFileDiff(status.repoRoot, filePath, !!staged);
  });

  ipcMain.handle(IPC.GIT_SAVE_FILE, async (_event, { sessionId, filePath, content }: { sessionId: string; filePath: string; content: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string' || typeof content !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return saveFile(status.repoRoot, filePath, content);
  });

  ipcMain.handle(IPC.GIT_STAGE_FILE, async (_event, { sessionId, filePath }: { sessionId: string; filePath: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return stageFile(status.repoRoot, filePath);
  });

  ipcMain.handle(IPC.GIT_UNSTAGE_FILE, async (_event, { sessionId, filePath }: { sessionId: string; filePath: string }) => {
    if (typeof sessionId !== 'string' || typeof filePath !== 'string') {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return unstageFile(status.repoRoot, filePath);
  });

  ipcMain.handle(IPC.GIT_STAGE_ALL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return stageAll(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_UNSTAGE_ALL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return unstageAll(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_COMMIT, async (_event, { sessionId, message }: { sessionId: string; message: string }) => {
    if (typeof sessionId !== 'string' || typeof message !== 'string' || !message.trim()) {
      throw new Error('Invalid parameters');
    }
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitCommit(status.repoRoot, message);
  });

  ipcMain.handle(IPC.GIT_PUSH, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitPush(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_PULL, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitPull(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_LOG, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') throw new Error('Invalid parameters');
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) throw new Error('Session not found');
    const status = await getGitStatus(cwd);
    if (!status.isRepo) throw new Error('Not a git repository');
    return gitLog(status.repoRoot);
  });

  ipcMain.handle(IPC.GIT_BRANCH_INFO, async (_event, { sessionId }: { sessionId: string }) => {
    if (typeof sessionId !== 'string') return null;
    const cwd = sessionManager.getSessionCwd(sessionId);
    if (!cwd) return null;
    const status = await getGitStatus(cwd);
    if (!status.isRepo) return null;
    return gitBranchInfo(status.repoRoot);
  });

  // ── Drawing canvas persistence ─────────────────────────────────────────────
  const canvasDir = path.join(app.getPath('home'), '.agentplex');
  const canvasPath = path.join(canvasDir, 'canvas.json');

  ipcMain.handle(IPC.CANVAS_LOAD, async (): Promise<DrawingData> => {
    try {
      const raw = fs.readFileSync(canvasPath, 'utf-8');
      return JSON.parse(raw) as DrawingData;
    } catch {
      return { elements: [], version: 1 };
    }
  });

  ipcMain.handle(IPC.CANVAS_SAVE, async (_event, data: DrawingData): Promise<void> => {
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(canvasPath, JSON.stringify(data), 'utf-8');
  });

  // Return persisted state (state.json) so renderer can read UUIDs
  ipcMain.handle(IPC.SESSION_GET_PERSISTED, async () => {
    return sessionManager.loadState();
  });

  // ── Workspace templates ────────────────────────────────────────────────────
  const templatesPath = path.join(canvasDir, 'templates.json');

  ipcMain.handle(IPC.TEMPLATES_LOAD, async (): Promise<WorkspaceTemplate[]> => {
    try {
      return JSON.parse(fs.readFileSync(templatesPath, 'utf-8'));
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.TEMPLATES_SAVE, async (_event, templates: WorkspaceTemplate[]): Promise<void> => {
    fs.mkdirSync(canvasDir, { recursive: true });
    fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf-8');
  });
}

import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { homedir } from 'os';
import { IPC } from '../shared/ipc-channels';
import { getShellById } from './shell-detector';
import { getDefaultShellId } from './settings-manager';

const REDACTED_ENV_KEYS = new Set([
  'AGENTPLEX_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
]);

function getSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !REDACTED_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

function resolveDefaultShell(): string {
  const savedId = getDefaultShellId();
  if (savedId) {
    const saved = getShellById(savedId);
    if (saved) return saved.path;
  }
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

const TERMINAL_BUFFER_CAP = 256 * 1024; // 256KB rolling buffer

interface SessionTerminal {
  sessionId: string;
  pty: pty.IPty;
  buffer: string;
  cwd: string;
}

class SessionTerminalManager {
  private terminals = new Map<string, SessionTerminal>();
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  private send(channel: string, payload: unknown) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, payload);
    }
  }

  openTerminal(sessionId: string, cwd: string, cols: number = 120, rows: number = 30): { pid: number } {
    const existing = this.terminals.get(sessionId);
    if (existing) {
      return { pid: existing.pty.pid };
    }

    const workDir = cwd || homedir();
    const shell = resolveDefaultShell();
    const isZsh = shell.endsWith('zsh');
    const args = isZsh ? ['-o', 'no_prompt_sp'] : [];

    const env = getSafeEnv();
    env.PROMPT_EOL_MARK = '';

    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workDir,
      env,
    });

    const entry: SessionTerminal = {
      sessionId,
      pty: term,
      buffer: '',
      cwd: workDir,
    };

    term.onData((data) => {
      entry.buffer += data;
      if (entry.buffer.length > TERMINAL_BUFFER_CAP) {
        entry.buffer = entry.buffer.slice(-TERMINAL_BUFFER_CAP);
      }
      this.send(IPC.SESSION_TERMINAL_DATA, { sessionId, data });
    });

    term.onExit(({ exitCode }) => {
      this.terminals.delete(sessionId);
      this.send(IPC.SESSION_TERMINAL_EXIT, { sessionId, exitCode });
    });

    this.terminals.set(sessionId, entry);
    return { pid: term.pid };
  }

  write(sessionId: string, data: string): void {
    const term = this.terminals.get(sessionId);
    if (term) {
      try {
        term.pty.write(data);
      } catch {
        // already dead
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const term = this.terminals.get(sessionId);
    if (term) {
      try {
        term.pty.resize(cols, rows);
      } catch {
        // ignore
      }
    }
  }

  getBuffer(sessionId: string): string {
    const raw = this.terminals.get(sessionId)?.buffer || '';
    // eslint-disable-next-line no-control-regex
    return raw.replace(/^(?:\x1b\[[0-9;]*m)*%(?:\x1b\[[0-9;]*m)*\s*(\r|\n)+\s*/, '');
  }

  kill(sessionId: string): void {
    const term = this.terminals.get(sessionId);
    if (term) {
      try {
        term.pty.kill();
      } catch {
        // already dead
      }
      this.terminals.delete(sessionId);
    }
  }

  killAll(): void {
    for (const term of this.terminals.values()) {
      try {
        term.pty.kill();
      } catch {
        // already dead
      }
    }
    this.terminals.clear();
  }
}

export const sessionTerminalManager = new SessionTerminalManager();

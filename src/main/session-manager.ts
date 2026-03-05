import * as pty from 'node-pty';
import { BrowserWindow } from 'electron';
import { SessionStatus, SessionInfo, IPC } from '../shared/ipc-channels';

interface Session {
  id: string;
  title: string;
  pty: pty.IPty;
  status: SessionStatus;
  lastOutput: number;
}

let sessionCounter = 0;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  start() {
    this.statusInterval = setInterval(() => this.checkStatuses(), 500);
  }

  stop() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
    for (const session of this.sessions.values()) {
      try {
        session.pty.kill();
      } catch {
        // already dead
      }
    }
    this.sessions.clear();
  }

  create(): SessionInfo {
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const title = `Session ${sessionCounter}`;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.env.HOME || process.env.USERPROFILE || '.',
      env: process.env as Record<string, string>,
    });

    const session: Session = {
      id,
      title,
      pty: term,
      status: SessionStatus.Running,
      lastOutput: Date.now(),
    };

    term.onData((data: string) => {
      session.lastOutput = Date.now();
      this.send(IPC.SESSION_DATA, { id, data });
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = SessionStatus.Killed;
      this.send(IPC.SESSION_STATUS, { id, status: SessionStatus.Killed });
      this.send(IPC.SESSION_EXIT, { id, exitCode });
    });

    this.sessions.set(id, session);

    // Auto-start claude after a short delay for shell to initialize
    setTimeout(() => {
      try {
        term.write('claude\r');
      } catch {
        // session may have been killed
      }
    }, 1000);

    return { id, title, status: SessionStatus.Running, pid: term.pid };
  }

  write(id: string, data: string) {
    const session = this.sessions.get(id);
    if (session && session.status !== SessionStatus.Killed) {
      session.pty.write(data);
    }
  }

  resize(id: string, cols: number, rows: number) {
    const session = this.sessions.get(id);
    if (session && session.status !== SessionStatus.Killed) {
      try {
        session.pty.resize(cols, rows);
      } catch {
        // ignore resize errors
      }
    }
  }

  kill(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      try {
        session.pty.kill();
      } catch {
        // already dead
      }
      session.status = SessionStatus.Killed;
      this.send(IPC.SESSION_STATUS, { id, status: SessionStatus.Killed });
    }
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      pid: s.pty.pid,
    }));
  }

  private checkStatuses() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.status === SessionStatus.Killed) continue;

      const newStatus =
        now - session.lastOutput < 2000
          ? SessionStatus.Running
          : SessionStatus.Idle;

      if (newStatus !== session.status) {
        session.status = newStatus;
        this.send(IPC.SESSION_STATUS, {
          id: session.id,
          status: newStatus,
        });
      }
    }
  }

  private send(channel: string, data: unknown) {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, data);
    }
  }
}

export const sessionManager = new SessionManager();

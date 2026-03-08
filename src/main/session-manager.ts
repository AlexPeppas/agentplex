import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { SessionStatus, SessionInfo, IPC } from '../shared/ipc-channels';
import { SubagentDetector } from './subagent-detector';
import { PlanTaskDetector } from './plan-task-detector';

const BUFFER_CAP = 512 * 1024; // 512KB per session

interface Session {
  id: string;
  title: string;
  pty: pty.IPty;
  status: SessionStatus;
  lastOutput: number;
  buffer: string;
  subagentDetector: SubagentDetector;
  planTaskDetector: PlanTaskDetector;
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

  create(cwd?: string): SessionInfo {
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd || process.env.HOME || process.env.USERPROFILE || '.';
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: process.env as Record<string, string>,
    });

    const detector = new SubagentDetector((event) => {
      if (event.type === 'spawn') {
        this.send(IPC.SUBAGENT_SPAWN, {
          sessionId: id,
          subagentId: event.subagentId,
          description: event.description,
        });
      } else {
        this.send(IPC.SUBAGENT_COMPLETE, {
          sessionId: id,
          subagentId: event.subagentId,
          description: event.description,
        });
      }
    });

    const planDetector = new PlanTaskDetector((event) => {
      switch (event.type) {
        case 'plan-enter': {
          let planTitle = 'Plan Mode';
          if (event.planSlug) {
            try {
              const home = process.env.HOME || process.env.USERPROFILE || '';
              const planPath = path.join(home, '.claude', 'plans', `${event.planSlug}.md`);
              const content = fs.readFileSync(planPath, 'utf-8');
              const headingMatch = content.match(/^#\s+(.+)/m);
              if (headingMatch) {
                const extracted = headingMatch[1].trim();
                // Reject empty or punctuation/dash-only titles (file may not be fully written yet)
                if (extracted && !/^[\s\-—–_.…]+$/.test(extracted)) {
                  planTitle = extracted;
                }
              }
            } catch {
              // file not found or unreadable
            }
          }
          this.send(IPC.PLAN_ENTER, { sessionId: id, planTitle });
          break;
        }
        case 'plan-exit':
          this.send(IPC.PLAN_EXIT, { sessionId: id });
          break;
        case 'task-create':
          this.send(IPC.TASK_CREATE, { sessionId: id, taskNumber: event.taskNumber, description: event.description });
          break;
        case 'task-update':
          this.send(IPC.TASK_UPDATE, { sessionId: id, taskNumber: event.taskNumber, status: event.status });
          break;
        case 'task-list':
          this.send(IPC.TASK_LIST, { sessionId: id, tasks: event.tasks });
          break;
      }
    });

    const session: Session = {
      id,
      title,
      pty: term,
      status: SessionStatus.Running,
      lastOutput: Date.now(),
      buffer: '',
      subagentDetector: detector,
      planTaskDetector: planDetector,
    };

    term.onData((data: string) => {
      session.lastOutput = Date.now();
      session.buffer += data;
      if (session.buffer.length > BUFFER_CAP) {
        session.buffer = session.buffer.slice(-BUFFER_CAP);
      }
      detector.feed(data);
      planDetector.feed(data);
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
      try {
        session.pty.write(data);
      } catch {
        // pty may have died between status check and write
      }
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

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer || '';
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

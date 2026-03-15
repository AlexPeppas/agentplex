import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { SessionStatus, SessionInfo, IPC, CLI_TOOLS, type CliTool } from '../shared/ipc-channels';
import { stripAnsi } from '../shared/ansi-strip';
import { JsonlSessionWatcher, encodeProjectPath } from './jsonl-session-watcher';
import { PlanTaskDetector } from './plan-task-detector';

const PROMPT_PATTERNS = [
  /\[Y\/n\]/i,                                   // [Y/n], [y/N] variants
  /\(y\/n\)/i,                                   // (y/N), (Y/n) variants
  /\b(?:do you want|proceed|confirm|approve)\b/i, // common prompt phrases
  /Yes\s*\/\s*No/,                                // Yes / No (Claude CLI)
  /Allow\s*\/\s*Deny/,                            // Allow / Deny (Claude CLI)
  /Enter to select/,                              // Claude CLI multi-choice selection
  /Esc to cancel/,                                // Claude CLI selection navigation hint
  /Tab\/Arrow keys to navigate/,                  // Claude CLI selection navigation hint
];

const BUFFER_CAP = 512 * 1024; // 512KB per session

interface Session {
  id: string;
  title: string;
  pty: pty.IPty;
  status: SessionStatus;
  lastOutput: number;
  lastVisibleOutput: number;
  buffer: string;
  jsonlWatcher: JsonlSessionWatcher | null;
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
      if (session.jsonlWatcher) session.jsonlWatcher.stop();
      try {
        session.pty.kill();
      } catch {
        // already dead
      }
    }
    this.sessions.clear();
  }

  create(cwd?: string, cli: CliTool = 'claude'): SessionInfo {
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd || process.env.HOME || process.env.USERPROFILE || '.';
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const toolDef = CLI_TOOLS.find((t) => t.id === cli) || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: process.env as Record<string, string>,
    });

    // Generate session UUID and set up JSONL watcher for Claude CLI only
    let jsonlWatcher: JsonlSessionWatcher | null = null;
    let sessionUuid: string | null = null;

    if (cli === 'claude') {
      sessionUuid = crypto.randomUUID();
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const encodedPath = encodeProjectPath(workDir);
      const jsonlPath = path.join(home, '.claude', 'projects', encodedPath, `${sessionUuid}.jsonl`);

      jsonlWatcher = new JsonlSessionWatcher(jsonlPath);

      jsonlWatcher.on('agent-spawn', (event: { toolUseId: string; description: string; subagentType: string }) => {
        this.send(IPC.SUBAGENT_SPAWN, {
          sessionId: id,
          subagentId: event.toolUseId,
          description: event.description,
        });
      });

      jsonlWatcher.on('agent-complete', (event: { toolUseId: string }) => {
        this.send(IPC.SUBAGENT_COMPLETE, {
          sessionId: id,
          subagentId: event.toolUseId,
        });
      });

      jsonlWatcher.start();
    }

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
      lastVisibleOutput: Date.now(),
      buffer: '',
      jsonlWatcher,
      planTaskDetector: planDetector,
    };

    term.onData((data: string) => {
      session.lastOutput = Date.now();
      if (stripAnsi(data).trim()) {
        session.lastVisibleOutput = Date.now();
      }
      session.buffer += data;
      if (session.buffer.length > BUFFER_CAP) {
        session.buffer = session.buffer.slice(-BUFFER_CAP);
      }
      planDetector.feed(data);
      this.send(IPC.SESSION_DATA, { id, data });
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = SessionStatus.Killed;
      if (session.jsonlWatcher) session.jsonlWatcher.stop();
      this.send(IPC.SESSION_STATUS, { id, status: SessionStatus.Killed });
      this.send(IPC.SESSION_EXIT, { id, exitCode });
    });

    this.sessions.set(id, session);

    // Auto-start the selected CLI tool after a short delay for shell to initialize
    const command = sessionUuid
      ? `${toolDef.command} --session-id ${sessionUuid}`
      : toolDef.command;

    setTimeout(() => {
      try {
        term.write(command + '\r');
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
      if (session.jsonlWatcher) session.jsonlWatcher.stop();
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

      let newStatus: SessionStatus;
      if (now - session.lastVisibleOutput < 2000) {
        newStatus = SessionStatus.Running;
      } else {
        // Idle — check if the session is waiting for user input.
        // Claude CLI draws interactive prompts with cursor-based TUI rendering,
        // so the stripped buffer may not have clean newlines. Check both:
        //  1) the full stripped tail as a single string (handles incremental TUI draws)
        //  2) individual lines (handles well-formed output)
        const tail = stripAnsi(session.buffer.slice(-500));
        const matchesFull = PROMPT_PATTERNS.some((re) => re.test(tail));
        const matchesLine = !matchesFull && tail.split('\n').filter((l) => l.trim()).slice(-5)
          .some((line) => PROMPT_PATTERNS.some((re) => re.test(line.trim())));
        newStatus = (matchesFull || matchesLine) ? SessionStatus.WaitingForInput : SessionStatus.Idle;
      }

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

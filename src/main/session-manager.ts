import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { BrowserWindow } from 'electron';
import { SessionStatus, SessionInfo, IPC, CLI_TOOLS, RESUME_TOOL, type CliTool } from '../shared/ipc-channels';
import { stripAnsi } from '../shared/ansi-strip';
import { JsonlSessionWatcher, encodeProjectPath } from './jsonl-session-watcher';
import { PlanTaskDetector } from './plan-task-detector';

const PROMPT_PATTERNS = [
  /\[Y\/n\]/i,                                   // [Y/n], [y/N] variants
  /\(y\/n\)/i,                                   // (y/N), (Y/n) variants
  /\b(?:do you want|proceed|confirm|approve|allow)\b/i, // common prompt phrases
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
  /** Timestamp when WaitingForInput was first detected (0 = not waiting) */
  waitingSince: number;
  /** Buffer length at the time HITL was detected — used to tell real output from redraws */
  waitingBufferLen: number;
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
    const allTools = [...CLI_TOOLS, RESUME_TOOL];
    const toolDef = allTools.find((t) => t.id === cli) || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: process.env as Record<string, string>,
    });

    // Set up JSONL watcher for Claude CLI sessions
    let jsonlWatcher: JsonlSessionWatcher | null = null;
    let sessionUuid: string | null = null;
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const encodedPath = encodeProjectPath(workDir);

    if (cli === 'claude') {
      // New session: generate UUID upfront so we know the JSONL path immediately
      sessionUuid = crypto.randomUUID();
      const jsonlPath = path.join(home, '.claude', 'projects', encodedPath, `${sessionUuid}.jsonl`);
      jsonlWatcher = this.createJsonlWatcher(jsonlPath, id);
      jsonlWatcher.start();
    } else if (cli === 'claude-resume') {
      // Resume: the user picks the session interactively, so we discover the
      // session ID by polling ~/.claude/sessions/<pid>.json after the CLI starts.
      this.discoverResumedSession(term.pid, home, encodedPath, id);
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
      waitingSince: 0,
      waitingBufferLen: 0,
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
    // Only pass --session-id for new claude sessions, not resume (user picks session interactively)
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

  private createJsonlWatcher(jsonlPath: string, sessionId: string): JsonlSessionWatcher {
    const watcher = new JsonlSessionWatcher(jsonlPath);

    watcher.on('agent-spawn', (event: { toolUseId: string; description: string; subagentType: string }) => {
      this.send(IPC.SUBAGENT_SPAWN, {
        sessionId,
        subagentId: event.toolUseId,
        description: event.description,
      });
    });

    watcher.on('agent-complete', (event: { toolUseId: string }) => {
      this.send(IPC.SUBAGENT_COMPLETE, {
        sessionId,
        subagentId: event.toolUseId,
      });
    });

    return watcher;
  }

  /**
   * For `claude --resume`: we don't know the session ID upfront because the
   * user picks it interactively. Watch the projects JSONL directory for
   * whichever .jsonl file starts receiving new writes after launch.
   */
  private discoverResumedSession(
    _ptyPid: number,
    home: string,
    encodedPath: string,
    sessionId: string,
  ): void {
    const projectDir = path.join(home, '.claude', 'projects', encodedPath);
    const launchTime = Date.now();
    let attempts = 0;
    const maxAttempts = 120; // 60 seconds at 500ms intervals

    // Snapshot existing file mtimes so we can detect which one changes
    const baselineMtimes = new Map<string, number>();
    try {
      for (const file of fs.readdirSync(projectDir)) {
        if (!file.endsWith('.jsonl')) continue;
        try {
          const stat = fs.statSync(path.join(projectDir, file));
          baselineMtimes.set(file, stat.mtimeMs);
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist yet */ }

    const poll = setInterval(() => {
      attempts++;
      const session = this.sessions.get(sessionId);
      if (!session || session.status === SessionStatus.Killed || attempts > maxAttempts) {
        clearInterval(poll);
        return;
      }

      try {
        const files = fs.readdirSync(projectDir);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          try {
            const stat = fs.statSync(path.join(projectDir, file));
            const baseline = baselineMtimes.get(file) ?? 0;
            // File was modified after we launched — this is the resumed session
            if (stat.mtimeMs > launchTime && stat.mtimeMs > baseline) {
              const jsonlPath = path.join(projectDir, file);
              const watcher = this.createJsonlWatcher(jsonlPath, sessionId);
              session.jsonlWatcher = watcher;
              watcher.start();
              clearInterval(poll);
              return;
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist yet */ }
    }, 500);
  }

  private checkStatuses() {
    const now = Date.now();
    // Minimum new visible bytes before we consider the session "responded" after HITL
    const HITL_RESPONSE_THRESHOLD = 80;

    for (const session of this.sessions.values()) {
      if (session.status === SessionStatus.Killed) continue;

      const tail = stripAnsi(session.buffer.slice(-500));
      const trimmedTail = tail.trimEnd();

      // Check if the CLI is at a prompt — this takes priority over recency.
      // Claude CLI shows "> " when waiting for user input.
      const atPrompt = /^>\s*$/m.test(trimmedTail.split('\n').pop() || '');

      // Check for interactive prompts (Y/n, Allow/Deny, etc.)
      const matchesFull = PROMPT_PATTERNS.some((re) => re.test(tail));
      const matchesLine = !matchesFull && tail.split('\n').filter((l) => l.trim()).slice(-5)
        .some((line) => PROMPT_PATTERNS.some((re) => re.test(line.trim())));

      const promptDetected = atPrompt || matchesFull || matchesLine;

      let newStatus: SessionStatus;
      if (promptDetected) {
        newStatus = SessionStatus.WaitingForInput;
        // Mark the moment and buffer length when HITL was first detected
        if (session.waitingSince === 0) {
          session.waitingSince = now;
          session.waitingBufferLen = session.buffer.length;
        }
      } else if (session.waitingSince > 0) {
        // HITL was previously detected — only transition away if we see
        // substantial new output (meaning the user actually responded and
        // the CLI is producing real content, not just terminal redraws).
        const newBytes = session.buffer.length - session.waitingBufferLen;
        if (newBytes > HITL_RESPONSE_THRESHOLD) {
          // Real response detected — clear the sticky lock
          session.waitingSince = 0;
          session.waitingBufferLen = 0;
          newStatus = now - session.lastVisibleOutput < 2000
            ? SessionStatus.Running
            : SessionStatus.Idle;
        } else {
          // Not enough new output — keep WaitingForInput sticky
          newStatus = SessionStatus.WaitingForInput;
        }
      } else if (now - session.lastVisibleOutput < 2000) {
        newStatus = SessionStatus.Running;
      } else {
        newStatus = SessionStatus.Idle;
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

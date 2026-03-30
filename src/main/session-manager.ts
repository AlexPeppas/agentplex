import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import { homedir } from 'os';
import { SessionStatus, IPC, CLI_TOOLS, RESUME_TOOL } from '../shared/ipc-channels';
import type { SessionInfo, CliTool, ExternalSession } from '../shared/ipc-channels';
import { getShellById } from './shell-detector';
import { getDefaultShellId } from './settings-manager';
import { stripAnsi } from '../shared/ansi-strip';
import { JsonlSessionWatcher, encodeProjectPath } from './jsonl-session-watcher';
import { renderJsonlTranscript } from './claude-session-scanner';
import { PlanTaskDetector } from './plan-task-detector';
import { resolveClaudeConfig } from './config-loader';

const STATE_PATH = path.join(homedir(), '.agentplex', 'state.json');

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Env vars to strip from PTY sessions to prevent secret leakage */
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

/** Resolve the user's default shell from settings or detection, with safe fallbacks. */
function resolveDefaultShell(): string {
  const savedId = getDefaultShellId();
  if (savedId) {
    const saved = getShellById(savedId);
    if (saved) return saved.path;
  }
  if (process.platform === 'win32') return 'powershell.exe';
  return process.env.SHELL || '/bin/zsh';
}

interface Session {
  id: string;
  title: string;
  /** User-facing name (starts as title, updated by rename) */
  displayName: string;
  cli: CliTool;
  cwd: string;
  claudeSessionUuid: string | null;
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

interface PersistedSession {
  displayName: string;
  cwd: string;
  cli: CliTool;
  claudeSessionUuid: string | null;
}

export interface PersistedState {
  sessions: Record<string, PersistedSession>;
}

let sessionCounter = 0;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private window: BrowserWindow | null = null;

  setWindow(win: BrowserWindow) {
    this.window = win;
  }

  /** Load persisted state from disk */
  loadState(): PersistedState {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      return { sessions: {} };
    }
  }

  /** Persist all sessions in the Map to disk */
  private saveState() {
    const state: PersistedState = { sessions: {} };
    for (const session of this.sessions.values()) {
      state.sessions[session.id] = {
        displayName: session.displayName,
        cwd: session.cwd,
        cli: session.cli,
        claudeSessionUuid: session.claudeSessionUuid,
      };
    }
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    } catch (err: any) {
      console.error('[state] Failed to save:', err.message);
    }
  }

  /** Update display name in memory and persist */
  updateDisplayName(sessionId: string, displayName: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.displayName = displayName;
      this.saveState();
    }
  }

  start() {
    this.statusInterval = setInterval(() => this.checkStatuses(), 500);
  }

  /**
   * Restore persisted Claude sessions from state.json.
   * Returns SessionInfo[] for each restored session so the renderer can add them.
   */
  restoreAll(): { info: SessionInfo; displayName: string }[] {
    const state = this.loadState();
    const results: { info: SessionInfo; displayName: string }[] = [];

    for (const [oldId, persisted] of Object.entries(state.sessions)) {
      // Only Claude sessions with a UUID can be resumed
      if (!persisted.claudeSessionUuid) continue;
      try {
        // Validate cwd exists before restoring
        if (!fs.existsSync(persisted.cwd) || !fs.statSync(persisted.cwd).isDirectory()) {
          console.warn(`[restore] Skipping ${oldId}: cwd "${persisted.cwd}" does not exist`);
          continue;
        }
        // Create a new session that resumes the Claude conversation
        const info = this.createWithUuid(
          persisted.cwd,
          persisted.cli,
          persisted.claudeSessionUuid
        );
        results.push({ info, displayName: persisted.displayName });
        console.log(`[restore] Restored "${persisted.displayName}" (${persisted.claudeSessionUuid})`);
      } catch (err: any) {
        console.error(`[restore] Failed to restore ${oldId}:`, err.message);
      }
    }

    // Save state once after all sessions are restored (not during each createWithUuid)
    this.saveState();

    return results;
  }

  /**
   * Create a session with a specific Claude session UUID (for restore).
   */
  private createWithUuid(cwd: string, cli: CliTool, claudeSessionUuid: string, forceResume = false): SessionInfo {
    if (!UUID_RE.test(claudeSessionUuid)) {
      throw new Error(`Invalid session UUID: ${claudeSessionUuid}`);
    }
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd;
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const toolDef = CLI_TOOLS.find((t) => t.id === cli) || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    const shell = resolveDefaultShell();
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: getSafeEnv(),
    });

    const home = homedir();
    const encodedPath = encodeProjectPath(workDir);
    const jsonlPath = path.join(home, '.claude', 'projects', encodedPath, `${claudeSessionUuid}.jsonl`);
    const jsonlWatcher = this.createJsonlWatcher(jsonlPath, id);
    jsonlWatcher.start();

    const planDetector = new PlanTaskDetector((event) => {
      switch (event.type) {
        case 'plan-enter': {
          let planTitle = 'Plan Mode';
          if (event.planSlug) {
            try {
              const planPath = path.join(home, '.claude', 'plans', `${event.planSlug}.md`);
              const content = fs.readFileSync(planPath, 'utf-8');
              const headingMatch = content.match(/^#\s+(.+)/m);
              if (headingMatch) {
                const extracted = headingMatch[1].trim();
                if (extracted && !/^[\s\-—–_.…]+$/.test(extracted)) {
                  planTitle = extracted;
                }
              }
            } catch { /* ignore */ }
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
      displayName: title,
      cli,
      cwd: workDir,
      claudeSessionUuid,
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

    // Pre-populate the terminal with the JSONL transcript so the user sees
    // the familiar conversation history before the --resume recap.
    if (forceResume) {
      const transcript = renderJsonlTranscript(jsonlPath);
      if (transcript) {
        this.send(IPC.SESSION_DATA, { id, data: transcript });
      }
    }

    // Use --resume if we know this is a real conversation to resume (forceResume from
    // smart-resume flow, or JSONL file exists on disk). Fall back to --session-id only
    // when restoring a session that was saved but never had a conversation.
    const hasConversation = forceResume || (fs.existsSync(jsonlPath) && fs.statSync(jsonlPath).size > 0);
    const config = resolveClaudeConfig(workDir);
    const flagStr = config.flags.length > 0 ? ' ' + config.flags.join(' ') : '';
    const command = hasConversation
      ? `${config.command}${flagStr} --resume ${claudeSessionUuid}`
      : `${config.command}${flagStr} --session-id ${claudeSessionUuid}`;
    setTimeout(() => {
      try {
        term.write(command + '\r');
      } catch { /* session may have been killed */ }
    }, 1000);

    return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir, cli };
  }

  stop() {
    // Flush state to disk before shutting down
    this.saveState();
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

  create(cwd?: string, cli: CliTool = 'claude', resumeSessionId?: string): SessionInfo {
    // Direct resume by UUID — delegate to createWithUuid which handles --resume <uuid>.
    // forceResume=true because the session was picked from the scanner, so we know
    // the JSONL exists — avoids a path-encoding mismatch that could cause a fallback
    // to --session-id instead of --resume.
    if (resumeSessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(resumeSessionId)) {
      const workDir = cwd || homedir();
      const info = this.createWithUuid(workDir, 'claude', resumeSessionId, true);
      this.saveState();
      return info;
    }

    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd || homedir();
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const cliTools = [...CLI_TOOLS, RESUME_TOOL];
    const matchedCliTool = cliTools.find((t) => t.id === cli);
    const isRawShell = !matchedCliTool;
    const toolDef = matchedCliTool || CLI_TOOLS[0];
    const title = `Session ${sessionCounter} — ${dirName}`;

    // Use detected shell path if available, otherwise user's default
    const detected = getShellById(cli);
    const shell = isRawShell
      ? (detected?.path || resolveDefaultShell())
      : resolveDefaultShell();
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: getSafeEnv(),
    });

    // Set up JSONL watcher for Claude CLI sessions
    let jsonlWatcher: JsonlSessionWatcher | null = null;
    let sessionUuid: string | null = null;
    const home = homedir();
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
              const home = homedir();
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
      displayName: title,
      cli,
      cwd: workDir,
      claudeSessionUuid: sessionUuid,
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

    // Auto-start the selected CLI tool after a short delay for shell to initialize.
    // Raw shell sessions (powershell/bash) skip this — the PTY is already the shell.
    if (!isRawShell) {
      let command: string;
      if (cli === 'claude' || cli === 'claude-resume') {
        const config = resolveClaudeConfig(workDir);
        const flagStr = config.flags.length > 0 ? ' ' + config.flags.join(' ') : '';
        if (sessionUuid) {
          command = `${config.command}${flagStr} --session-id ${sessionUuid}`;
        } else {
          // claude-resume: interactive picker
          command = `${config.command}${flagStr} --resume`;
        }
      } else {
        command = toolDef.command;
      }

      setTimeout(() => {
        try {
          term.write(command + '\r');
        } catch {
          // session may have been killed
        }
      }, 1000);
    }

    this.saveState();

    return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir, cli };
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
      this.sessions.delete(id);
      this.saveState();
    }
  }

  getBuffer(id: string): string {
    return this.sessions.get(id)?.buffer || '';
  }

  getCwd(id: string): string | null {
    return this.sessions.get(id)?.cwd ?? null;
  }

  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      pid: s.pty.pid,
      cwd: s.cwd,
      cli: s.cli,
    }));
  }

  /** Return the working directory for a session */
  getSessionCwd(id: string): string | null {
    return this.sessions.get(id)?.cwd ?? null;
  }

  /** Return the JSONL conversation file path for a session, or null */
  getJsonlPath(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session?.claudeSessionUuid || !session.cwd) return null;
    const home = homedir();
    const encodedPath = encodeProjectPath(session.cwd);
    return path.join(home, '.claude', 'projects', encodedPath, `${session.claudeSessionUuid}.jsonl`);
  }

  /** Return { sessionId → displayName } from in-memory sessions */
  getDisplayNames(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const session of this.sessions.values()) {
      names[session.id] = session.displayName;
    }
    return names;
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
              // Extract UUID from filename and persist so session can be restored
              const discoveredUuid = file.replace('.jsonl', '');
              if (UUID_RE.test(discoveredUuid)) {
                session.claudeSessionUuid = discoveredUuid;
                session.cli = 'claude'; // normalize — it's a regular Claude session now
                this.saveState();
              }
              clearInterval(poll);
              return;
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist yet */ }
    }, 500);
  }

  /**
   * Scan ~/.claude/sessions/*.json for externally-running Claude sessions
   * that are not already managed by AgentPlex.
   */
  discoverExternal(): ExternalSession[] {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const sessionsDir = path.join(home, '.claude', 'sessions');

    let files: string[];
    try {
      files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    // Collect UUIDs already managed by AgentPlex (in-memory + persisted)
    const managedUuids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.claudeSessionUuid) managedUuids.add(s.claudeSessionUuid);
    }
    const persisted = this.loadState();
    for (const ps of Object.values(persisted.sessions)) {
      if (ps.claudeSessionUuid) managedUuids.add(ps.claudeSessionUuid);
    }

    const results: ExternalSession[] = [];

    for (const file of files) {
      try {
        const filePath = path.join(sessionsDir, file);
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const pid = raw.pid as number;
        const sessionId = raw.sessionId as string;
        const cwd = raw.cwd as string;
        const startedAt = raw.startedAt as number;
        const name = raw.name as string | undefined;

        if (!pid || !sessionId || !cwd) continue;

        // Skip sessions already managed by AgentPlex
        if (managedUuids.has(sessionId)) continue;

        // Check if the process is still alive
        try {
          process.kill(pid, 0); // signal 0 = existence check, doesn't kill
        } catch {
          continue; // process is dead
        }

        // Only show standalone sessions — skip processes launched with
        // --session-id or --resume (those are AgentPlex-spawned or resumed)
        try {
          let cmdline = '';
          if (process.platform === 'linux') {
            cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
          } else if (process.platform === 'darwin') {
            cmdline = execSync(`ps -p ${pid} -o args=`, { encoding: 'utf-8' });
          }
          if (/--session-id|--resume/.test(cmdline)) continue;
        } catch {
          // Can't read cmdline — skip to be safe
          continue;
        }

        // The session file's sessionId can go stale if the user resumed or
        // /clear'd within the CLI — resolve the actual active UUID.
        const activeSessionId = this.resolveActiveSessionId(cwd, sessionId, managedUuids);

        // Re-check managed UUIDs with the resolved active session ID
        if (managedUuids.has(activeSessionId)) continue;

        results.push({ pid, sessionId: activeSessionId, cwd, startedAt, name });
      } catch {
        continue;
      }
    }

    // Sort by startedAt descending (most recent first)
    results.sort((a, b) => b.startedAt - a.startedAt);
    return results;
  }

  /**
   * Find the JSONL with the most recent user/assistant message in a project
   * directory. Returns the UUID of that file, or the fallback if none found.
   * File mtime alone is unreliable because /clear writes file-history-snapshots
   * to the OLD jsonl after creating the new one.
   */
  private resolveActiveSessionId(cwd: string, fallback: string, excludeUuids?: Set<string>): string {
    const home = homedir();
    const encodedPath = encodeProjectPath(cwd);
    const projectDir = path.join(home, '.claude', 'projects', encodedPath);
    let activeId = fallback;
    try {
      const jsonls = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
      let latestMsgTime = '';
      for (const jf of jsonls) {
        // Skip JSONL files belonging to AgentPlex-managed sessions
        const uuid = jf.replace('.jsonl', '');
        if (excludeUuids && UUID_RE.test(uuid) && excludeUuids.has(uuid)) continue;

        try {
          const filePath = path.join(projectDir, jf);
          const stat = fs.statSync(filePath);
          // file-history-snapshots after /clear can push messages 100KB+
          // from the end — read enough tail to reliably find them
          const tailSize = Math.min(128 * 1024, stat.size);
          const fd = fs.openSync(filePath, 'r');
          try {
            const buf = Buffer.alloc(tailSize);
            fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
            const tail = buf.toString('utf-8');
            const lines = tail.split('\n').filter((l) => l.trim());
            for (let i = lines.length - 1; i >= 0; i--) {
              try {
                const obj = JSON.parse(lines[i]);
                if ((obj.type === 'user' || obj.type === 'assistant') && obj.timestamp) {
                  if (obj.timestamp > latestMsgTime) {
                    latestMsgTime = obj.timestamp;
                    if (UUID_RE.test(uuid)) activeId = uuid;
                  }
                  break;
                }
              } catch { /* skip */ }
            }
          } finally {
            try {
              fs.closeSync(fd);
            } catch { /* ignore close errors */ }
          }
        } catch { /* skip */ }
      }
    } catch { /* project dir may not exist */ }
    return activeId;
  }

  /**
   * Adopt an externally-running Claude session into AgentPlex.
   * Spawns a new PTY that resumes the session via `claude --resume <uuid>`.
   */
  adoptExternal(sessionUuid: string, cwd: string): SessionInfo {
    if (!UUID_RE.test(sessionUuid)) {
      throw new Error(`Invalid session UUID: ${sessionUuid}`);
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    // Re-resolve at adoption time, excluding AgentPlex-managed sessions (in-memory + persisted)
    const managedUuids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.claudeSessionUuid) managedUuids.add(s.claudeSessionUuid);
    }
    const persisted = this.loadState();
    for (const ps of Object.values(persisted.sessions)) {
      if (ps.claudeSessionUuid) managedUuids.add(ps.claudeSessionUuid);
    }
    const activeUuid = this.resolveActiveSessionId(cwd, sessionUuid, managedUuids);
    const info = this.createWithUuid(cwd, 'claude', activeUuid, true);
    this.saveState();
    return info;
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

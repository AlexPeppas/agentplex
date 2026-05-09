import * as pty from 'node-pty';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { BrowserWindow } from 'electron';
import { homedir } from 'os';
import { SessionStatus, IPC, CLI_TOOLS, RESUME_TOOL, COPILOT_RESUME_TOOL } from '../shared/ipc-channels';
import type { SessionInfo, CliTool, ExternalSession } from '../shared/ipc-channels';
import { getShellById } from './shell-detector';
import { getDefaultShellId } from './settings-manager';
import { stripAnsi } from '../shared/ansi-strip';
import { JsonlSessionWatcher, encodeProjectPath, type WatcherFormat } from './jsonl-session-watcher';
import { renderJsonlTranscript } from './claude-session-scanner';
import { renderCopilotTranscript } from './copilot-session-scanner';
import { PlanTaskDetector } from './plan-task-detector';
import { resolveClaudeConfig } from './config-loader';

const STATE_PATH = path.join(homedir(), '.agentplex', 'state.json');

/**
 * Default delay between PTY spawn and the auto-launched CLI command.
 * Gives the underlying shell a moment to initialize before we type into it.
 */
const DEFAULT_LAUNCH_DELAY_MS = 1000;

/**
 * Per-session stagger added during restoreAll to avoid concurrent writes to
 * shared CLI config files (notably ~/.claude.json). The Claude CLI auto-saves
 * its config on every launch; if N processes spawn simultaneously they race
 * on read-modify-write and produce malformed JSON, which Claude then resets
 * to defaults — wiping the user's project history. Spreading launches by 1s
 * means each Claude finishes its config write before the next one starts.
 */
const RESTORE_STAGGER_MS = 300;

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
  /** Per-CLI session ID used to resume (Claude UUID, Copilot UUID, …) */
  resumeSessionId: string | null;
  pty: pty.IPty;
  status: SessionStatus;
  lastOutput: number;
  lastVisibleOutput: number;
  /** Timestamp when WaitingForInput was first detected (0 = not waiting) */
  waitingSince: number;
  /** Buffer length at the time HITL was detected — used to tell real output from redraws */
  waitingBufferLen: number;
  /** Copilot-only: true while a permission.requested has not been resolved by permission.completed */
  waitingForPermission: boolean;
  buffer: string;
  jsonlWatcher: JsonlSessionWatcher | null;
  planTaskDetector: PlanTaskDetector;
}

interface PersistedSession {
  displayName: string;
  cwd: string;
  cli: CliTool;
  /** Per-CLI session ID used to resume on restart */
  resumeSessionId: string | null;
}

/** Old persisted-session shape with `claudeSessionUuid` — read for one-shot migration. */
interface LegacyPersistedSession {
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

  /** Load persisted state from disk. Migrates old `claudeSessionUuid` → `resumeSessionId`. */
  loadState(): PersistedState {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
      if (raw && typeof raw === 'object' && raw.sessions && typeof raw.sessions === 'object') {
        for (const ps of Object.values(raw.sessions) as Array<PersistedSession & Partial<LegacyPersistedSession>>) {
          if (ps && ps.resumeSessionId === undefined) {
            ps.resumeSessionId = ps.claudeSessionUuid ?? null;
          }
        }
      }
      return raw as PersistedState;
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
        resumeSessionId: session.resumeSessionId,
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
   * Restore persisted sessions (Claude + Copilot) from state.json.
   * Returns SessionInfo[] for each restored session so the renderer can add them.
   */
  restoreAll(): { info: SessionInfo; displayName: string }[] {
    const state = this.loadState();
    const results: { info: SessionInfo; displayName: string }[] = [];

    // Stagger CLI launches so multiple Claude/Copilot processes don't race on
    // shared config files (notably ~/.claude.json — a known Windows footgun
    // when 10+ sessions all `claude --resume` within the same second).
    let staggerIndex = 0;

    for (const [oldId, persisted] of Object.entries(state.sessions)) {
      // Only sessions with a known resume ID for a supported CLI can be restored
      if (!persisted.resumeSessionId) continue;
      if (
        persisted.cli !== 'claude' &&
        persisted.cli !== 'claude-resume' &&
        persisted.cli !== 'copilot' &&
        persisted.cli !== 'copilot-resume'
      ) continue;
      try {
        // Validate cwd exists before restoring
        if (!fs.existsSync(persisted.cwd) || !fs.statSync(persisted.cwd).isDirectory()) {
          console.warn(`[restore] Skipping ${oldId}: cwd "${persisted.cwd}" does not exist`);
          continue;
        }
        const launchDelayMs = DEFAULT_LAUNCH_DELAY_MS + staggerIndex * RESTORE_STAGGER_MS;
        staggerIndex++;
        const info = this.createWithUuid(
          persisted.cwd,
          persisted.cli,
          persisted.resumeSessionId,
          false,
          launchDelayMs,
        );
        results.push({ info, displayName: persisted.displayName });
        console.log(`[restore] Restored "${persisted.displayName}" (${persisted.cli}: ${persisted.resumeSessionId}) — launch in ${launchDelayMs}ms`);
      } catch (err: any) {
        console.error(`[restore] Failed to restore ${oldId}:`, err.message);
      }
    }

    // Save state once after all sessions are restored (not during each createWithUuid)
    this.saveState();

    return results;
  }

  /**
   * Create a session with a pre-known resume ID. Used for:
   *  - Restoring persisted sessions on app start
   *  - Resuming an existing Claude session picked from the launcher
   *  - Adopting an external Claude session
   *  - Launching a new session (Claude or Copilot) where we mint the UUID upfront
   *    so app restart and templates can resume it later
   *
   * `forceResume = true` means "we already know the conversation exists" — skip the
   * file existence probe and use --resume immediately. (Claude only — for Copilot
   * the resume command shape is the same whether the session is new or existing.)
   *
   * `launchDelayMs` controls how long to wait after PTY spawn before writing the
   * auto-launch command. restoreAll passes increasing values per session to
   * stagger Claude/Copilot startups and avoid racing on shared config files.
   */
  private createWithUuid(cwd: string, cli: CliTool, resumeSessionId: string, forceResume = false, launchDelayMs: number = DEFAULT_LAUNCH_DELAY_MS): SessionInfo {
    if (!UUID_RE.test(resumeSessionId)) {
      throw new Error(`Invalid session UUID: ${resumeSessionId}`);
    }
    if (cli !== 'claude' && cli !== 'claude-resume' && cli !== 'copilot' && cli !== 'copilot-resume') {
      throw new Error(`createWithUuid: CLI '${cli}' does not support resume`);
    }
    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd;
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const title = `Session ${sessionCounter} — ${dirName}`;
    const isClaude = cli === 'claude' || cli === 'claude-resume';

    const shell = resolveDefaultShell();
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: workDir,
      env: getSafeEnv(),
    });

    const home = homedir();

    let jsonlPath: string | null = null;
    let jsonlWatcher: JsonlSessionWatcher | null = null;
    if (isClaude) {
      const encodedPath = encodeProjectPath(workDir);
      jsonlPath = path.join(home, '.claude', 'projects', encodedPath, `${resumeSessionId}.jsonl`);
      jsonlWatcher = this.createJsonlWatcher(jsonlPath, id, 'claude');
      jsonlWatcher.start();
    } else if (cli === 'copilot') {
      // ~/.copilot/session-state/<uuid>/events.jsonl is the append-only event log.
      // Used both for sub-agent detection (subagent.started + tool.execution_complete)
      // and for "Running" status detection via mtime in checkStatuses().
      jsonlPath = path.join(home, '.copilot', 'session-state', resumeSessionId, 'events.jsonl');
      jsonlWatcher = this.createJsonlWatcher(jsonlPath, id, 'copilot');
      jsonlWatcher.start();
    }

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
      resumeSessionId,
      pty: term,
      status: SessionStatus.Running,
      lastOutput: Date.now(),
      lastVisibleOutput: Date.now(),
      waitingSince: 0,
      waitingBufferLen: 0,
      waitingForPermission: false,
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
      // The PlanTaskDetector regex set is Claude-specific (matches "plan mode on",
      // ~/.claude/plans/<slug>.md, TodoWrite checkbox glyphs). Don't feed Copilot
      // output through it — plan/permission state for Copilot comes from events.jsonl.
      if (isClaude) planDetector.feed(data);
      this.send(IPC.SESSION_DATA, { id, data });
    });

    term.onExit(({ exitCode }: { exitCode: number }) => {
      session.status = SessionStatus.Killed;
      if (session.jsonlWatcher) session.jsonlWatcher.stop();
      this.send(IPC.SESSION_STATUS, { id, status: SessionStatus.Killed });
      this.send(IPC.SESSION_EXIT, { id, exitCode });
    });

    this.sessions.set(id, session);

    // Pre-populate the terminal with the conversation transcript so the user sees
    // their history immediately on resume.
    //
    //   - Claude: the CLI replays the conversation itself on `--resume`, so we only
    //     pre-render on smart-resume (forceResume=true) as a UX nicety to fill the
    //     1s gap before the CLI starts.
    //   - Copilot: the CLI does NOT replay visually on `--resume=<uuid>` (only the
    //     interactive picker form does). Always pre-render — the renderer returns
    //     an empty string for missing/empty events.jsonl, so brand-new sessions get
    //     no spurious transcript.
    if (jsonlPath) {
      const transcript = isClaude
        ? (forceResume ? renderJsonlTranscript(jsonlPath) : '')
        : renderCopilotTranscript(jsonlPath);
      if (transcript) {
        this.send(IPC.SESSION_DATA, { id, data: transcript });
      }
    }

    // Build the launch command for the chosen CLI.
    let command: string;
    if (isClaude) {
      // Use --resume if we know this is a real conversation to resume (forceResume from
      // smart-resume flow, or JSONL file exists on disk). Fall back to --session-id only
      // when restoring a session that was saved but never had a conversation.
      const hasConversation = forceResume || (jsonlPath !== null && fs.existsSync(jsonlPath) && fs.statSync(jsonlPath).size > 0);
      const config = resolveClaudeConfig(workDir);
      const flagStr = config.flags.length > 0 ? ' ' + config.flags.join(' ') : '';
      command = hasConversation
        ? `${config.command}${flagStr} --resume ${resumeSessionId}`
        : `${config.command}${flagStr} --session-id ${resumeSessionId}`;
    } else {
      // Copilot: --resume=<uuid> works for both new (with pre-set UUID) and existing
      // sessions per `copilot --help`. The `--` separator stops gh from interpreting
      // any future flags as its own.
      command = `gh copilot -- --resume=${resumeSessionId}`;
    }

    setTimeout(() => {
      try {
        term.write(command + '\r');
      } catch { /* session may have been killed */ }
    }, launchDelayMs);

    return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir, cli, resumeSessionId: session.resumeSessionId };
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
    // Direct resume by UUID — delegate to createWithUuid which knows the per-CLI shape.
    // forceResume=true (Claude path) because the session was picked from the scanner or
    // a template, so we know the JSONL exists — avoids a path-encoding mismatch that
    // could cause a fallback to --session-id instead of --resume.
    if (resumeSessionId && UUID_RE.test(resumeSessionId)) {
      const workDir = cwd || homedir();
      const resumeCli: CliTool = (cli === 'claude' || cli === 'claude-resume' || cli === 'copilot') ? cli : 'claude';
      const info = this.createWithUuid(workDir, resumeCli, resumeSessionId, true);
      this.saveState();
      return info;
    }

    // New Copilot session: mint a UUID upfront and launch via --resume=<uuid> so the
    // session can be restored on app restart and saved into templates with parity to Claude.
    if (cli === 'copilot') {
      const workDir = cwd || homedir();
      const info = this.createWithUuid(workDir, 'copilot', crypto.randomUUID(), false);
      this.saveState();
      return info;
    }

    sessionCounter++;
    const id = `session-${sessionCounter}`;
    const workDir = cwd || homedir();
    const dirName = workDir.replace(/\\/g, '/').split('/').pop() || workDir;
    const cliTools = [...CLI_TOOLS, RESUME_TOOL, COPILOT_RESUME_TOOL];
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
    } else if (cli === 'copilot-resume') {
      // Same idea for Copilot: launch `gh copilot --resume` (no UUID), let the CLI's
      // native picker take input, then poll ~/.copilot/session-state for whichever
      // events.jsonl gets newly written to. That tells us which session was picked.
      this.discoverResumedCopilotSession(home, id);
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
      resumeSessionId: sessionUuid,
      pty: term,
      status: SessionStatus.Running,
      lastOutput: Date.now(),
      lastVisibleOutput: Date.now(),
      waitingSince: 0,
      waitingBufferLen: 0,
      waitingForPermission: false,
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

    return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir, cli, resumeSessionId: session.resumeSessionId };
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
      resumeSessionId: s.resumeSessionId,
    }));
  }

  /** Return the working directory for a session */
  getSessionCwd(id: string): string | null {
    return this.sessions.get(id)?.cwd ?? null;
  }

  /** Return the JSONL conversation file path for a Claude session, or null. */
  getJsonlPath(id: string): string | null {
    const session = this.sessions.get(id);
    if (!session?.resumeSessionId || !session.cwd) return null;
    if (session.cli !== 'claude' && session.cli !== 'claude-resume') return null;
    const home = homedir();
    const encodedPath = encodeProjectPath(session.cwd);
    return path.join(home, '.claude', 'projects', encodedPath, `${session.resumeSessionId}.jsonl`);
  }

  /** Return { sessionId → displayName } from in-memory sessions */
  getDisplayNames(): Record<string, string> {
    const names: Record<string, string> = {};
    for (const session of this.sessions.values()) {
      names[session.id] = session.displayName;
    }
    return names;
  }

  private createJsonlWatcher(jsonlPath: string, sessionId: string, format: WatcherFormat = 'claude'): JsonlSessionWatcher {
    const watcher = new JsonlSessionWatcher(jsonlPath, format);

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

    if (format === 'copilot') {
      // Copilot's plan.md is a sibling of events.jsonl — read it for the plan title
      // (mirrors how Claude reads ~/.claude/plans/<slug>.md from a slug in the event).
      const planMdPath = path.join(path.dirname(jsonlPath), 'plan.md');

      watcher.on('plan-changed', () => {
        let planTitle = 'Plan Mode';
        try {
          const content = fs.readFileSync(planMdPath, 'utf-8');
          const headingMatch = content.match(/^#\s+(.+)/m);
          if (headingMatch) {
            const extracted = headingMatch[1].trim();
            // Reject empty or punctuation/dash-only titles (file may not be fully written yet).
            if (extracted && !/^[\s\-—–_.…]+$/.test(extracted)) {
              planTitle = extracted;
            }
          }
        } catch { /* plan.md may not exist yet — fall back to default title */ }
        this.send(IPC.PLAN_ENTER, { sessionId, planTitle });
      });

      watcher.on('plan-deleted', () => {
        this.send(IPC.PLAN_EXIT, { sessionId });
      });

      // Permission events drive WaitingForInput status immediately — no need to wait
      // for the next 500ms checkStatuses tick. The flag is also consulted there to
      // keep the status sticky across ticks until the user resolves the request.
      watcher.on('permission-requested', () => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.waitingForPermission = true;
        if (session.status !== SessionStatus.WaitingForInput) {
          session.status = SessionStatus.WaitingForInput;
          this.send(IPC.SESSION_STATUS, { id: sessionId, status: SessionStatus.WaitingForInput });
        }
      });

      watcher.on('permission-completed', () => {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.waitingForPermission = false;
        // Status normalizes to Running/Idle on the next checkStatuses tick (within 500ms).
      });
    }

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
                session.resumeSessionId = discoveredUuid;
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
   * For `gh copilot --resume` (no UUID, interactive picker): the user picks the
   * session in the CLI's UI, so we discover the chosen UUID by polling
   * ~/.copilot/session-state for whichever session's events.jsonl starts
   * receiving new writes after launch. The directory name IS the UUID.
   *
   * Also reads workspace.yaml for the original session's cwd and updates
   * session.cwd so the AgentPlex UI shows the correct directory.
   */
  private discoverResumedCopilotSession(home: string, sessionId: string): void {
    const stateDir = path.join(home, '.copilot', 'session-state');
    const launchTime = Date.now();
    let attempts = 0;
    const maxAttempts = 120; // 60 seconds at 500ms intervals

    // Snapshot existing events.jsonl mtimes per session-state dir.
    // Sessions without an events.jsonl get baseline 0 (they'd appear as "newly written"
    // if the user picks one and the CLI starts writing).
    const baselineMtimes = new Map<string, number>();
    try {
      for (const dir of fs.readdirSync(stateDir)) {
        if (!UUID_RE.test(dir)) continue;
        const eventsPath = path.join(stateDir, dir, 'events.jsonl');
        try {
          baselineMtimes.set(dir, fs.statSync(eventsPath).mtimeMs);
        } catch {
          baselineMtimes.set(dir, 0);
        }
      }
    } catch { /* stateDir may not exist yet */ }

    const poll = setInterval(() => {
      attempts++;
      const session = this.sessions.get(sessionId);
      if (!session || session.status === SessionStatus.Killed || attempts > maxAttempts) {
        clearInterval(poll);
        return;
      }

      try {
        for (const dir of fs.readdirSync(stateDir)) {
          if (!UUID_RE.test(dir)) continue;
          const eventsPath = path.join(stateDir, dir, 'events.jsonl');
          let stat: fs.Stats;
          try {
            stat = fs.statSync(eventsPath);
          } catch { continue; }
          const baseline = baselineMtimes.get(dir) ?? 0;
          if (stat.mtimeMs > launchTime && stat.mtimeMs > baseline) {
            // Discovered the picked session.
            session.resumeSessionId = dir;
            session.cli = 'copilot'; // normalize — picker is done, it's a regular Copilot session
            // Wire the events.jsonl watcher (sub-agent + plan + permission detection).
            const watcher = this.createJsonlWatcher(eventsPath, sessionId, 'copilot');
            session.jsonlWatcher = watcher;
            watcher.start();
            // Update session.cwd from workspace.yaml so the UI / git panel reflect the
            // session's real working directory rather than wherever the PTY was spawned.
            try {
              const wsPath = path.join(stateDir, dir, 'workspace.yaml');
              const wsContent = fs.readFileSync(wsPath, 'utf-8');
              const cwdMatch = wsContent.match(/^cwd:\s*(.+)$/m);
              if (cwdMatch) {
                const realCwd = cwdMatch[1].trim();
                if (realCwd && fs.existsSync(realCwd) && fs.statSync(realCwd).isDirectory()) {
                  session.cwd = realCwd;
                }
              }
            } catch { /* workspace.yaml absent or unreadable — keep PTY cwd */ }
            // Push the corrected SessionInfo to the renderer so templates pick up the
            // real cwd and the git/explorer panels use the right directory.
            this.send(IPC.SESSION_INFO_UPDATE, {
              id: sessionId,
              cli: session.cli,
              cwd: session.cwd,
              resumeSessionId: session.resumeSessionId,
            });
            this.saveState();
            clearInterval(poll);
            return;
          }
        }
      } catch { /* stateDir doesn't exist yet */ }
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

    // Collect UUIDs already managed by AgentPlex (in-memory + persisted).
    // We only need Claude UUIDs here — copilot resume IDs live in a different namespace
    // and can never collide with the JSONLs in ~/.claude/projects.
    const managedUuids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.resumeSessionId && (s.cli === 'claude' || s.cli === 'claude-resume')) {
        managedUuids.add(s.resumeSessionId);
      }
    }
    const persisted = this.loadState();
    for (const ps of Object.values(persisted.sessions)) {
      if (ps.resumeSessionId && (ps.cli === 'claude' || ps.cli === 'claude-resume')) {
        managedUuids.add(ps.resumeSessionId);
      }
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
    // Re-resolve at adoption time, excluding AgentPlex-managed Claude sessions
    // (in-memory + persisted). Copilot resume IDs live in a different namespace.
    const managedUuids = new Set<string>();
    for (const s of this.sessions.values()) {
      if (s.resumeSessionId && (s.cli === 'claude' || s.cli === 'claude-resume')) {
        managedUuids.add(s.resumeSessionId);
      }
    }
    const persisted = this.loadState();
    for (const ps of Object.values(persisted.sessions)) {
      if (ps.resumeSessionId && (ps.cli === 'claude' || ps.cli === 'claude-resume')) {
        managedUuids.add(ps.resumeSessionId);
      }
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
    // JSONL must have been written within this window to count as "Running"
    const JSONL_ACTIVE_MS = 5000;

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

      // Use the watcher's JSONL file mtime as the ground truth for "Running".
      // Claude writes ~/.claude/projects/<encodedPath>/<uuid>.jsonl while working;
      // Copilot writes ~/.copilot/session-state/<uuid>/events.jsonl. Both append
      // continuously while the CLI is active. Terminal output is too noisy
      // (redraws, cursor repositioning) to be a reliable signal.
      let jsonlActive = false;
      if (session.jsonlWatcher) {
        try {
          const stat = fs.statSync(session.jsonlWatcher.jsonlPath);
          jsonlActive = (now - stat.mtimeMs) < JSONL_ACTIVE_MS;
        } catch { /* file may not exist yet */ }
      }

      let newStatus: SessionStatus;
      if (session.waitingForPermission) {
        // Copilot fast-path: an outstanding permission.requested event holds the session
        // in WaitingForInput until permission.completed arrives. Don't touch
        // waitingSince/waitingBufferLen — those are owned by the buffer-pattern HITL path.
        newStatus = SessionStatus.WaitingForInput;
      } else if (promptDetected) {
        newStatus = SessionStatus.WaitingForInput;
        if (session.waitingSince === 0) {
          session.waitingSince = now;
          session.waitingBufferLen = session.buffer.length;
        }
      } else if (session.waitingSince > 0) {
        const newBytes = session.buffer.length - session.waitingBufferLen;
        if (newBytes > HITL_RESPONSE_THRESHOLD) {
          session.waitingSince = 0;
          session.waitingBufferLen = 0;
          newStatus = jsonlActive ? SessionStatus.Running : SessionStatus.Idle;
        } else {
          newStatus = SessionStatus.WaitingForInput;
        }
      } else if (jsonlActive) {
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

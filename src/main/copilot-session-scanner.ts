import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { DiscoveredProject, DiscoveredSession } from '../shared/ipc-channels';
import { getPinnedProjects } from './claude-session-scanner';

const COPILOT_STATE_DIR = path.join(homedir(), '.copilot', 'session-state');
const MAX_SESSIONS = 50;
const MSG_PREVIEW_LEN = 120;

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

/** Max bytes to read from the events.jsonl file for the transcript preview. */
const TRANSCRIPT_MAX_BYTES = 512 * 1024; // 512KB

/**
 * Read a Copilot ~/.copilot/session-state/<uuid>/events.jsonl and render a
 * human-readable, ANSI-coloured transcript suitable for writing into an xterm
 * terminal.
 *
 * The Copilot CLI does NOT visually replay the conversation when launched via
 * `gh copilot --resume=<uuid>` (only the interactive picker form does), so we
 * pre-populate the terminal with this transcript before sending the resume
 * command. That way the user sees prior history immediately on app restart
 * and template launches — the same UX Claude provides natively.
 *
 * Returns the rendered string (with \r\n line endings for the PTY) or an
 * empty string if the file cannot be read or has no renderable messages.
 */
export function renderCopilotTranscript(eventsPath: string): string {
  let text: string;
  try {
    const stat = fs.statSync(eventsPath);
    const bytesToRead = Math.min(stat.size, TRANSCRIPT_MAX_BYTES);
    const offset = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(eventsPath, 'r');
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, offset);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
    // If we started mid-file, drop the first (likely partial) line
    if (offset > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
  } catch {
    return '';
  }

  const lines: string[] = [];

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    let record: any;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }

    const type = record.type as string | undefined;
    const data = record.data;
    if (!type || !data || typeof data !== 'object') continue;

    if (type === 'user.message') {
      // data.content is the original user text; data.transformedContent has system-reminder
      // wrappers we don't want shown back to the user.
      const content = data.content;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${BOLD}${GREEN}> You${RESET}`);
        lines.push(content);
        lines.push('');
      }
    } else if (type === 'assistant.message') {
      const content = data.content;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${BOLD}${CYAN}Copilot${RESET}`);
        lines.push(content);
        lines.push('');
      }
    } else if (type === 'tool.execution_start') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : 'tool';
      const args = (data.arguments && typeof data.arguments === 'object') ? data.arguments : {};
      // Sub-agent calls use toolName='task' with agent_type + description.
      // Other tools commonly carry one of: command, pattern, file_path, query, description.
      let label = toolName;
      let preview: string;
      if (toolName === 'task') {
        const agentType = typeof args.agent_type === 'string' ? args.agent_type : '';
        if (agentType) label = `Sub-agent (${agentType})`;
        else label = 'Sub-agent';
        preview = typeof args.description === 'string' ? args.description : '';
      } else {
        const desc = args.description || args.command || args.pattern || args.file_path || args.query || '';
        preview = typeof desc === 'string' ? desc : '';
      }
      preview = preview.slice(0, 120);
      lines.push(`${DIM}${MAGENTA}  ⚙ ${label}${preview ? ': ' + preview : ''}${RESET}`);
    }
    // Skip session.*, system.*, hooks, turns, permissions, subagent.started
    // (already covered by tool.execution_start), tool.execution_complete, etc.
  }

  if (lines.length === 0) return '';

  const separator = `${DIM}${YELLOW}${'─'.repeat(60)}${RESET}`;
  const header = `${DIM}${YELLOW}  Session transcript (from events.jsonl)${RESET}`;
  const footer = `${DIM}${YELLOW}  Resuming session…${RESET}`;

  return [separator, header, separator, '', ...lines, separator, footer, separator, ''].join('\r\n');
}

function readWorkspaceCwd(workspaceYamlPath: string): string | null {
  try {
    const content = fs.readFileSync(workspaceYamlPath, 'utf-8');
    const match = content.match(/^cwd:\s*(.+)$/m);
    if (!match) return null;
    let cwd = match[1].trim();
    if ((cwd.startsWith('"') && cwd.endsWith('"')) || (cwd.startsWith("'") && cwd.endsWith("'"))) {
      cwd = cwd.slice(1, -1);
    }
    return cwd || null;
  } catch {
    return null;
  }
}

function parseEventsMetadata(eventsPath: string): {
  customTitle: string | null;
  firstUserMessage: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  cwd: string | null;
} {
  let customTitle: string | null = null;
  let firstUserMessage: string | null = null;
  let gitBranch: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;

  try {
    const raw = fs.readFileSync(eventsPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        const type = record.type;
        const data = record.data;
        if (record.timestamp && typeof record.timestamp === 'string') {
          if (!firstTimestamp) firstTimestamp = record.timestamp;
          lastTimestamp = record.timestamp;
        }
        if (!data || typeof data !== 'object') continue;
        if (!cwd) {
          cwd = data.context?.cwd || data.cwd || null;
        }
        if (!gitBranch) {
          gitBranch = data.context?.branch || data.gitBranch || data.branch || null;
        }
        if (!customTitle && typeof data.title === 'string' && data.title.trim()) {
          customTitle = data.title.trim();
        }
        if (type === 'user.message' && !firstUserMessage && typeof data.content === 'string' && data.content.trim()) {
          firstUserMessage = data.content.length > MSG_PREVIEW_LEN
            ? data.content.slice(0, MSG_PREVIEW_LEN) + '...'
            : data.content;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* ignore */ }

  return { customTitle, firstUserMessage, gitBranch, firstTimestamp, lastTimestamp, cwd };
}

/** Scan ~/.copilot/session-state and group sessions by workspace cwd. */
export async function scanProjects(): Promise<DiscoveredProject[]> {
  const pins = getPinnedProjects();
  const pinnedPaths = new Set(pins.map((p) => p.path));
  const byProject = new Map<string, { sessionCount: number; latestMtimeMs: number }>();

  let entries: string[];
  try {
    entries = await fs.promises.readdir(COPILOT_STATE_DIR);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const dir = path.join(COPILOT_STATE_DIR, entry);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const workspaceYaml = path.join(dir, 'workspace.yaml');
    const cwd = readWorkspaceCwd(workspaceYaml);
    if (!cwd) continue;

    const eventsPath = path.join(dir, 'events.jsonl');
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(eventsPath)).mtimeMs;
    } catch { /* keep zero */ }

    const prev = byProject.get(cwd);
    if (prev) {
      prev.sessionCount += 1;
      prev.latestMtimeMs = Math.max(prev.latestMtimeMs, mtimeMs);
    } else {
      byProject.set(cwd, { sessionCount: 1, latestMtimeMs: mtimeMs });
    }
  }

  const results: DiscoveredProject[] = Array.from(byProject.entries()).map(([cwd, meta]) => ({
    encodedPath: cwd,
    realPath: cwd,
    dirName: cwd.replace(/[\\/]/g, '/').split('/').pop() || cwd,
    sessionCount: meta.sessionCount,
    lastActivity: meta.latestMtimeMs > 0 ? new Date(meta.latestMtimeMs).toISOString() : '',
    isPinned: pinnedPaths.has(cwd),
  }));

  for (const pin of pins) {
    if (!results.some((r) => r.realPath === pin.path)) {
      const dirName = pin.label || pin.path.replace(/[\\/]/g, '/').split('/').pop() || pin.path;
      results.push({
        encodedPath: pin.path,
        realPath: pin.path,
        dirName,
        sessionCount: 0,
        lastActivity: '',
        isPinned: true,
      });
    }
  }

  results.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.lastActivity || '').localeCompare(a.lastActivity || '');
  });

  return results;
}

/** Scan Copilot sessions for a specific workspace path (projectPath from scanProjects). */
export async function scanSessionsForProject(projectPath: string): Promise<DiscoveredSession[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(COPILOT_STATE_DIR);
  } catch {
    return [];
  }

  const sessions: DiscoveredSession[] = [];

  for (const entry of entries) {
    const dir = path.join(COPILOT_STATE_DIR, entry);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const workspaceYaml = path.join(dir, 'workspace.yaml');
    const cwd = readWorkspaceCwd(workspaceYaml);
    if (!cwd || path.resolve(cwd) !== path.resolve(projectPath)) continue;

    const eventsPath = path.join(dir, 'events.jsonl');
    const meta = parseEventsMetadata(eventsPath);

    sessions.push({
      sessionId: entry,
      projectPath: cwd,
      customTitle: meta.customTitle,
      firstUserMessage: meta.firstUserMessage,
      gitBranch: meta.gitBranch,
      lastTimestamp: meta.lastTimestamp || meta.firstTimestamp,
    });
  }

  sessions.sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''));
  return sessions.slice(0, MAX_SESSIONS);
}

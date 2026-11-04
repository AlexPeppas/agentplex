import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { DiscoveredProject, DiscoveredSession } from '../shared/ipc-channels';
import { getPinnedProjects } from './claude-session-scanner';
import { readHistoryLines } from './history-reader';
import { EMPTY_CONVERSATION, upsertConversation, type ConversationInput } from '../shared/conversation';

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
export function renderCopilotTranscript(eventsPath: string, snapshotEnd?: number, mode: 'resume' | 'monitor' = 'resume'): string {
  return readCopilotTranscript(eventsPath, snapshotEnd, mode).transcript;
}

export function readCopilotTranscript(eventsPath: string, snapshotEnd?: number, mode: 'resume' | 'monitor' = 'resume') {
  let text: string;
  let conversation = EMPTY_CONVERSATION;
  try {
    const stat = fs.statSync(eventsPath);
    const end = Math.min(stat.size, snapshotEnd ?? stat.size);
    const bytesToRead = Math.min(end, TRANSCRIPT_MAX_BYTES);
    const offset = Math.max(0, end - bytesToRead);
    if (offset > 0) conversation = { ...conversation, truncated: true };
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
  } catch (error) {
    if (mode === 'monitor' && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { transcript: '', conversation };
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

    const rendered = renderCopilotRecord(record);
    if (rendered) lines.push(rendered);
    if (mode === 'monitor') {
      const entry = parseCopilotConversationEntry(record);
      if (entry) conversation = upsertConversation(conversation, entry).snapshot;
    }
  }

  if (lines.length === 0) return { transcript: '', conversation };
  const separator = `${DIM}${YELLOW}${'─'.repeat(60)}${RESET}`;
  const header = `${DIM}${YELLOW}  Session transcript (from events.jsonl)${RESET}`;
  const footer = `${DIM}${YELLOW}  ${mode === 'monitor' ? 'Live transcript - read only' : 'Resuming session…'}${RESET}`;
  return { transcript: [separator, header, separator, '', ...lines, separator, footer, separator, ''].join('\r\n'), conversation };
}

export function parseCopilotConversationEntry(record: unknown): ConversationInput | null {
  if (!record || typeof record !== 'object' || !('type' in record) || !('data' in record)) return null;
  const { type, data } = record;
  if (!data || typeof data !== 'object') return null;
  const timestamp = 'timestamp' in record && typeof record.timestamp === 'string' ? record.timestamp : undefined;
  const key = 'id' in record && typeof record.id === 'string' ? record.id : undefined;
  if (type === 'user.message' || type === 'assistant.message') {
    if (!('content' in data) || typeof data.content !== 'string' || !data.content.trim()) return null;
    return { key, kind: type === 'user.message' ? 'user' : 'assistant', text: data.content, timestamp };
  }
  const callId = 'toolCallId' in data && typeof data.toolCallId === 'string' ? data.toolCallId : undefined;
  if (type === 'tool.execution_start') {
    const name = 'toolName' in data && typeof data.toolName === 'string' ? data.toolName : 'tool';
    const args = 'arguments' in data && data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
    const description = 'description' in args && typeof args.description === 'string' ? args.description
      : 'command' in args && typeof args.command === 'string' ? args.command
        : 'pattern' in args && typeof args.pattern === 'string' ? args.pattern
          : 'file_path' in args && typeof args.file_path === 'string' ? args.file_path : '';
    return { key: callId ? `tool:${callId}` : key, kind: 'tool',
      text: `${name}${description ? ': ' + description : ''}`, status: 'running', timestamp };
  }
  if (type === 'tool.execution_complete' && callId) {
    const result = 'result' in data ? data.result : undefined;
    const error = 'error' in data ? data.error : undefined;
    const detail = typeof result === 'string' ? result
      : result && typeof result === 'object' && 'content' in result && typeof result.content === 'string' ? result.content
        : typeof error === 'string' ? error
          : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : undefined;
    return { key: `tool:${callId}`, kind: 'tool', text: '', detail,
      status: 'success' in data && typeof data.success === 'boolean' ? data.success ? 'success' : 'error' : undefined };
  }
  return null;
}

export function renderCopilotRecord(record: unknown): string {
    if (!record || typeof record !== 'object' || !('type' in record) || !('data' in record)) return '';
    const type = record.type;
    const data = record.data;
    if (!type || !data || typeof data !== 'object') return '';
    const lines: string[] = [];

    if (type === 'user.message') {
      // data.content is the original user text; data.transformedContent has system-reminder
      // wrappers we don't want shown back to the user.
      const content = 'content' in data ? data.content : undefined;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${BOLD}${GREEN}> You${RESET}`);
        lines.push(content);
        lines.push('');
      }
    } else if (type === 'assistant.message') {
      const content = 'content' in data ? data.content : undefined;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${BOLD}${CYAN}Copilot${RESET}`);
        lines.push(content);
        lines.push('');
      }
    } else if (type === 'tool.execution_start') {
      const toolName = 'toolName' in data && typeof data.toolName === 'string' ? data.toolName : 'tool';
      const args: Record<string, unknown> = 'arguments' in data && data.arguments && typeof data.arguments === 'object'
        ? data.arguments as Record<string, unknown> : {};
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
    return lines.join('\r\n').replace(/\r?\n/g, '\r\n');
}

export async function readWorkspaceCwd(workspaceYamlPath: string, signal?: AbortSignal): Promise<string | null> {
  for await (const line of readHistoryLines(workspaceYamlPath, 8192, false, signal)) {
    const match = line.match(/^cwd:\s*(.+)$/);
    if (!match) continue;
    let cwd = match[1].trim();
    if ((cwd.startsWith('"') && cwd.endsWith('"')) || (cwd.startsWith("'") && cwd.endsWith("'"))) {
      cwd = cwd.slice(1, -1);
    }
    return cwd || null;
  }
  return null;
}

async function parseEventsMetadata(eventsPath: string, signal?: AbortSignal): Promise<{
  customTitle: string | null;
  firstUserMessage: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  cwd: string | null;
}> {
  let customTitle: string | null = null;
  let firstUserMessage: string | null = null;
  let gitBranch: string | null = null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let cwd: string | null = null;

  // Metadata lives near session start; activity timestamps also need the tail.
  for (const tail of [false, true]) {
    for await (const line of readHistoryLines(eventsPath, 64 * 1024, tail, signal)) {
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
  }

  return { customTitle, firstUserMessage, gitBranch, firstTimestamp, lastTimestamp, cwd };
}

/** Scan ~/.copilot/session-state and group sessions by workspace cwd. */
export async function scanProjects(signal?: AbortSignal): Promise<DiscoveredProject[]> {
  signal?.throwIfAborted();
  const pins = getPinnedProjects();
  const pinnedPaths = new Set(pins.map((p) => p.path));
  const byProject = new Map<string, { sessionCount: number; latestMtimeMs: number }>();

  let entries: string[];
  try {
    entries = await fs.promises.readdir(COPILOT_STATE_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }

  for (const entry of entries) {
    signal?.throwIfAborted();
    const dir = path.join(COPILOT_STATE_DIR, entry);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }

    const workspaceYaml = path.join(dir, 'workspace.yaml');
    const cwd = await readWorkspaceCwd(workspaceYaml, signal);
    if (!cwd) continue;

    const eventsPath = path.join(dir, 'events.jsonl');
    let mtimeMs = 0;
    try {
      mtimeMs = (await fs.promises.stat(eventsPath)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

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
export async function scanSessionsForProject(projectPath: string, signal?: AbortSignal): Promise<DiscoveredSession[]> {
  signal?.throwIfAborted();
  let entries: string[];
  try {
    entries = await fs.promises.readdir(COPILOT_STATE_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }

  const candidates: { entry: string; cwd: string; eventsPath: string; mtimeMs: number }[] = [];

  for (const entry of entries) {
    signal?.throwIfAborted();
    const dir = path.join(COPILOT_STATE_DIR, entry);
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }

    const workspaceYaml = path.join(dir, 'workspace.yaml');
    const cwd = await readWorkspaceCwd(workspaceYaml, signal);
    if (!cwd || path.resolve(cwd) !== path.resolve(projectPath)) continue;

    const eventsPath = path.join(dir, 'events.jsonl');
    try {
      const stat = await fs.promises.stat(eventsPath);
      candidates.push({ entry, cwd, eventsPath, mtimeMs: stat.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions: DiscoveredSession[] = [];
  for (const { entry, cwd, eventsPath } of candidates.slice(0, MAX_SESSIONS)) {
    const meta = await parseEventsMetadata(eventsPath, signal);
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

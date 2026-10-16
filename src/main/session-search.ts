import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { SessionSearchResult } from '../shared/ipc-channels';
import { readWorkspaceCwd } from './copilot-session-scanner';
import { readHistoryLines } from './history-reader';

const COPILOT_STATE_DIR = path.join(homedir(), '.copilot', 'session-state');
const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');

const MIN_QUERY_LEN = 2;
/** Cap on how many session files we open per query, newest-first. */
const MAX_FILES_SCANNED = 500;
/** Cap on total results returned. */
const MAX_RESULTS = 200;
/** Cap on matches surfaced per individual session. */
const PER_SESSION_MATCHES = 5;
/** For very large files, read only this many trailing bytes (full history up to the cap). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Snippet window around a match. */
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 90;

interface Candidate {
  cli: 'claude' | 'copilot';
  filePath: string;
  sessionId: string;
  /** Known up-front for Copilot (workspace.yaml); resolved from content for Claude. */
  projectPath: string | null;
  mtimeMs: number;
}

interface ExtractedMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
  /** cwd carried on the record (Claude); used as a projectPath fallback. */
  cwd: string | null;
}

async function statMtime(p: string): Promise<number> {
  try {
    return (await fs.promises.stat(p)).mtimeMs;
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return 0;
  }
}

/** Gather candidate Copilot session files (one events.jsonl per session dir). */
async function gatherCopilotCandidates(signal?: AbortSignal): Promise<Candidate[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(COPILOT_STATE_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  const candidates: Candidate[] = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const dir = path.join(COPILOT_STATE_DIR, entry);
    const eventsPath = path.join(dir, 'events.jsonl');
    const mtimeMs = await statMtime(eventsPath);
    if (mtimeMs === 0) continue;
    candidates.push({ cli: 'copilot', filePath: eventsPath, sessionId: entry, projectPath: null, mtimeMs });
  }
  return candidates;
}

/** Gather candidate Claude session files (one jsonl per session, grouped by project dir). */
async function gatherClaudeCandidates(signal?: AbortSignal): Promise<Candidate[]> {
  let projectDirs: string[];
  try {
    projectDirs = await fs.promises.readdir(CLAUDE_PROJECTS_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  const candidates: Candidate[] = [];
  for (const projectDir of projectDirs) {
    signal?.throwIfAborted();
    const dir = path.join(CLAUDE_PROJECTS_DIR, projectDir);
    let files: string[];
    try {
      const stat = await fs.promises.stat(dir);
      if (!stat.isDirectory()) continue;
      files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      continue;
    }
    for (const file of files) {
      signal?.throwIfAborted();
      const filePath = path.join(dir, file);
      const mtimeMs = await statMtime(filePath);
      if (mtimeMs === 0) continue;
      candidates.push({
        cli: 'claude',
        filePath,
        sessionId: file.replace(/\.jsonl$/, ''),
        projectPath: null,
        mtimeMs,
      });
    }
  }
  return candidates;
}

/** Parse one JSONL line into a searchable message, per-CLI. Returns null to skip. */
function extractMessage(cli: 'claude' | 'copilot', line: string): ExtractedMessage | null {
  let record: any;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }

  if (cli === 'copilot') {
    const type = record.type as string | undefined;
    const data = record.data;
    if (!data || typeof data !== 'object') return null;
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
    const cwd = (data.context?.cwd || data.cwd || null) as string | null;
    if (type === 'user.message' || type === 'assistant.message') {
      const content = data.content;
      if (typeof content === 'string' && content.trim()) {
        return { role: type === 'user.message' ? 'user' : 'assistant', text: content, timestamp, cwd };
      }
    }
    return null;
  }

  // Claude
  const type = record.type as string | undefined;
  if (type !== 'user' && type !== 'assistant') return null;
  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  const cwd = typeof record.cwd === 'string' ? record.cwd : null;
  const content = record.message?.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Concatenate text blocks; skip tool_use/tool_result noise.
    text = content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  if (!text.trim()) return null;
  return { role: type, text, timestamp, cwd };
}

/** Build a single-line excerpt around the first match, with ellipses. */
function buildSnippet(text: string, lowerQuery: string): string | null {
  const idx = text.toLowerCase().indexOf(lowerQuery);
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_BEFORE);
  const end = Math.min(text.length, idx + lowerQuery.length + SNIPPET_AFTER);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip = snip + '…';
  return snip;
}

function projectNameOf(projectPath: string): string {
  return projectPath.replace(/[\\/]+$/, '').replace(/[\\/]/g, '/').split('/').pop() || projectPath;
}

/**
 * Search the on-disk session history (Claude + Copilot) for `query`.
 *
 * Substring, case-insensitive, on extracted user/assistant message text. Scans
 * the newest sessions first and stops once result caps are hit. On-demand
 * (callers should debounce); no persistent index in Phase 1.
 */
export async function searchSessions(query: string, signal?: AbortSignal): Promise<SessionSearchResult[]> {
  signal?.throwIfAborted();
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LEN) return [];
  const lowerQuery = trimmed.toLowerCase();

  const [copilot, claude] = await Promise.all([
    gatherCopilotCandidates(signal),
    gatherClaudeCandidates(signal),
  ]);

  const candidates = [...copilot, ...claude]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_SCANNED);

  const results: SessionSearchResult[] = [];

  for (const cand of candidates) {
    signal?.throwIfAborted();
    if (results.length >= MAX_RESULTS) break;

    let projectPath = cand.cli === 'copilot'
      ? await readWorkspaceCwd(path.join(path.dirname(cand.filePath), 'workspace.yaml'), signal)
      : cand.projectPath;
    let perSession = 0;

    for await (const rawLine of readHistoryLines(cand.filePath, MAX_FILE_BYTES, true, signal)) {
      const line = rawLine.trim();
      if (!line) continue;
      const msg = extractMessage(cand.cli, line);
      if (!msg) continue;
      if (!projectPath && msg.cwd) projectPath = msg.cwd;
      if (!msg.text.toLowerCase().includes(lowerQuery)) continue;

      const snippet = buildSnippet(msg.text, lowerQuery);
      if (!snippet) continue;

      const resolvedPath = projectPath || '';
      results.push({
        cli: cand.cli,
        sessionId: cand.sessionId,
        projectPath: resolvedPath,
        projectName: resolvedPath ? projectNameOf(resolvedPath) : '(unknown)',
        role: msg.role,
        snippet,
        timestamp: msg.timestamp || new Date(cand.mtimeMs).toISOString(),
      });
      perSession++;
      if (perSession >= PER_SESSION_MATCHES) break;
      if (results.length >= MAX_RESULTS) break;
    }
  }

  return results;
}

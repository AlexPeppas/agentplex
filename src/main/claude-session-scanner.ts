import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import type { DiscoveredProject, DiscoveredSession, PinnedProject } from '../shared/ipc-channels';

const CONFIG_PATH = path.join(homedir(), '.agentplex', 'config.json');
const CLAUDE_PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');

/** Max bytes to read from the start of a JSONL file for metadata extraction. */
const HEAD_BYTES = 8192;
/** Max sessions to return per project. */
const MAX_SESSIONS = 50;
/** Max chars for first user message preview. */
const MSG_PREVIEW_LEN = 120;

/**
 * Extract the real cwd from any JSONL file in a project directory.
 * Called lazily — only when the user actually clicks a project.
 */
export async function resolveProjectPath(encodedPath: string): Promise<string | null> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);
  try {
    const files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) return null;

    // Try files until we find one with a cwd field (some sessions are tiny stubs)
    for (const file of files.slice(0, 10)) {
      try {
        const filePath = path.join(projectDir, file);
        const handle = await fs.promises.open(filePath, 'r');
        const buf = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
        await handle.close();

        const text = buf.slice(0, bytesRead).toString('utf-8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.cwd && typeof obj.cwd === 'string') return obj.cwd;
          } catch { /* skip */ }
        }
      } catch { /* skip file */ }
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Read pinned projects from ~/.agentplex/config.json.
 */
export function getPinnedProjects(): PinnedProject[] {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return Array.isArray(data.pinnedProjects) ? data.pinnedProjects : [];
  } catch {
    return [];
  }
}

/**
 * Write pinned projects to ~/.agentplex/config.json, preserving other keys.
 */
export function updatePinnedProjects(pins: PinnedProject[]): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch { /* file doesn't exist yet */ }
  data.pinnedProjects = pins;
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Scan ~/.claude/projects/ and return discovered projects.
 */
export async function scanProjects(): Promise<DiscoveredProject[]> {
  const pins = getPinnedProjects();
  const pinnedPaths = new Set(pins.map((p) => p.path));
  const results: DiscoveredProject[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    // Directory doesn't exist
  }

  for (const entry of entries) {
    const fullDir = path.join(CLAUDE_PROJECTS_DIR, entry);
    try {
      const stat = await fs.promises.stat(fullDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Count JSONL files and find latest mtime
    let sessionCount = 0;
    let latestMtime = 0;
    try {
      const files = await fs.promises.readdir(fullDir);
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        sessionCount++;
        try {
          const s = await fs.promises.stat(path.join(fullDir, f));
          if (s.mtimeMs > latestMtime) latestMtime = s.mtimeMs;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    if (sessionCount === 0) continue;

    // Use encoded path as display — real path resolved lazily on click
    const dirName = entry.replace(/[\\/]/g, '/').split('/').pop() || entry;

    results.push({
      encodedPath: entry,
      realPath: entry, // placeholder — resolved lazily via resolveProjectPath
      dirName,
      sessionCount,
      lastActivity: latestMtime > 0 ? new Date(latestMtime).toISOString() : '',
      isPinned: pinnedPaths.has(entry),
    });
  }

  // Add pinned projects that weren't discovered
  for (const pin of pins) {
    if (!results.some((r) => r.realPath === pin.path)) {
      const dirName = pin.label || pin.path.replace(/[\\/]/g, '/').split('/').pop() || pin.path;
      results.push({
        encodedPath: '',
        realPath: pin.path,
        dirName,
        sessionCount: 0,
        lastActivity: '',
        isPinned: true,
      });
    }
  }

  // Sort: pinned first, then by last activity descending
  results.sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return (b.lastActivity || '').localeCompare(a.lastActivity || '');
  });

  return results;
}

/**
 * Extract metadata from the first bytes of a JSONL file.
 */
function parseJsonlHead(filePath: string): {
  customTitle: string | null;
  firstUserMessage: string | null;
  gitBranch: string | null;
  firstTimestamp: string | null;
  cwd: string | null;
} {
  let customTitle: string | null = null;
  let firstUserMessage: string | null = null;
  let gitBranch: string | null = null;
  let firstTimestamp: string | null = null;
  let cwd: string | null = null;

  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    fs.closeSync(fd);

    const text = buf.slice(0, bytesRead).toString('utf-8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (obj.type === 'custom-title' && obj.customTitle && !customTitle) {
          customTitle = obj.customTitle;
        }

        if (obj.cwd && !cwd) cwd = obj.cwd;

        if (obj.type === 'user' && obj.message?.content && !firstUserMessage) {
          const content = typeof obj.message.content === 'string'
            ? obj.message.content
            : JSON.stringify(obj.message.content);
          firstUserMessage = content.length > MSG_PREVIEW_LEN
            ? content.slice(0, MSG_PREVIEW_LEN) + '...'
            : content;
          if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;
          if (obj.timestamp && !firstTimestamp) firstTimestamp = obj.timestamp;
        }

        if (obj.gitBranch && !gitBranch) gitBranch = obj.gitBranch;

        if (customTitle && firstUserMessage && gitBranch && cwd) break;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return { customTitle, firstUserMessage, gitBranch, firstTimestamp, cwd };
}

/**
 * Get the last timestamp from a JSONL file by reading the tail.
 */
function getLastTimestamp(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    const tailSize = Math.min(4096, stat.size);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
    fs.closeSync(fd);

    const text = buf.toString('utf-8');
    const lines = text.split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.timestamp) return obj.timestamp;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

/**
 * Scan sessions for a specific project.
 */
export async function scanSessionsForProject(encodedPath: string): Promise<DiscoveredSession[]> {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);

  let files: string[];
  try {
    files = (await fs.promises.readdir(projectDir)).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  // Resolve the real project path once — used as fallback when a session has no cwd
  const resolvedPath = await resolveProjectPath(encodedPath);

  // Sort by mtime descending, cap at MAX_SESSIONS
  const withMtime: { file: string; mtime: number }[] = [];
  for (const f of files) {
    try {
      const s = await fs.promises.stat(path.join(projectDir, f));
      withMtime.push({ file: f, mtime: s.mtimeMs });
    } catch {
      withMtime.push({ file: f, mtime: 0 });
    }
  }
  withMtime.sort((a, b) => b.mtime - a.mtime);
  const topFiles = withMtime.slice(0, MAX_SESSIONS);

  const sessions: DiscoveredSession[] = [];

  for (const { file } of topFiles) {
    const sessionId = file.replace('.jsonl', '');
    const filePath = path.join(projectDir, file);
    const head = parseJsonlHead(filePath);
    const lastTimestamp = getLastTimestamp(filePath) || head.firstTimestamp;

    sessions.push({
      sessionId,
      projectPath: head.cwd || resolvedPath || encodedPath,
      customTitle: head.customTitle,
      firstUserMessage: head.firstUserMessage,
      gitBranch: head.gitBranch,
      lastTimestamp,
    });
  }

  return sessions;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const MAGENTA = '\x1b[35m';

/** Max bytes to read from the JSONL file for the transcript preview. */
const TRANSCRIPT_MAX_BYTES = 512 * 1024; // 512KB

/**
 * Read a session JSONL file and render a human-readable, ANSI-coloured
 * transcript suitable for writing into an xterm terminal.
 *
 * Returns the rendered string (with \r\n line endings for the PTY) or an
 * empty string if the file cannot be read.
 */
export function renderJsonlTranscript(jsonlPath: string): string {
  let text: string;
  try {
    const stat = fs.statSync(jsonlPath);
    const bytesToRead = Math.min(stat.size, TRANSCRIPT_MAX_BYTES);
    const offset = Math.max(0, stat.size - bytesToRead);
    const fd = fs.openSync(jsonlPath, 'r');
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
    const content = record.message?.content;

    // Skip non-message records
    if (type !== 'user' && type !== 'assistant') continue;

    if (type === 'user') {
      // Extract user text (skip tool_result blocks)
      if (typeof content === 'string') {
        lines.push(`${BOLD}${GREEN}> You${RESET}`);
        lines.push(content);
        lines.push('');
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            lines.push(`${BOLD}${GREEN}> You${RESET}`);
            lines.push(block.text);
            lines.push('');
          }
          // skip tool_result blocks — they're verbose and not useful for the recap
        }
      }
    } else if (type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          lines.push(`${BOLD}${CYAN}Claude${RESET}`);
          lines.push(block.text);
          lines.push('');
        } else if (block.type === 'tool_use') {
          const toolName = block.name || 'tool';
          const desc = block.input?.description || block.input?.command || block.input?.pattern || '';
          const preview = typeof desc === 'string' ? desc.slice(0, 120) : '';
          lines.push(`${DIM}${MAGENTA}  ⚙ ${toolName}${preview ? ': ' + preview : ''}${RESET}`);
        }
        // skip thinking blocks
      }
    }
  }

  if (lines.length === 0) return '';

  const separator = `${DIM}${YELLOW}${'─'.repeat(60)}${RESET}`;
  const header = `${DIM}${YELLOW}  Session transcript (from JSONL)${RESET}`;
  const footer = `${DIM}${YELLOW}  Resuming session…${RESET}`;

  const output = [separator, header, separator, '', ...lines, separator, footer, separator, ''].join('\r\n');
  return output;
}

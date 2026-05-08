import * as fs from 'fs';

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

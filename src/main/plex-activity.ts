import * as fs from 'node:fs';
import path from 'node:path';
import type { PlexActivity, PlexTranscript } from '../shared/plex';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value.slice(0, 8000) : '';

/** Only public conversation/tool fields are projected; private reasoning is never copied. */
export function copilotActivity(value: unknown): (PlexActivity & { delta?: boolean }) | null {
  const record = object(value);
  const data = object(record.data);
  const id = text(record.id) || `${String(record.type)}:${text(data.toolCallId) || text(data.messageId)}`;
  switch (record.type) {
    case 'user.message': return { id, kind: 'user', text: text(data.content) };
    case 'assistant.message_delta':
      return { id: text(data.messageId) || id, kind: 'assistant', text: text(data.deltaContent), delta: true };
    case 'assistant.message':
      return { id: text(data.messageId) || id, kind: 'assistant', text: text(data.content) };
    case 'assistant.turn_start':
    case 'assistant.reasoning_delta':
      return { id: 'thinking', kind: 'status', text: 'Thinking...' };
    case 'tool.execution_start':
      return { id: `${text(data.toolCallId) || id}:start`, kind: 'tool',
        text: `${text(data.toolName) || 'Tool'}\n${JSON.stringify(data.arguments ?? {}).slice(0, 7000)}` };
    case 'tool.execution_complete':
      return { id: `${text(data.toolCallId) || id}:end`, kind: 'tool',
        text: `${data.success === false ? 'Tool failed' : 'Tool finished'}: ${text(data.toolCallId)}\n` +
          JSON.stringify(data.result ?? data.error ?? '').slice(0, 7000) };
    default: return null;
  }
}

export function mergeActivity(entries: PlexActivity[], event: PlexActivity & { delta?: boolean }): void {
  const previous = entries.find(item => item.id === event.id);
  const next = { id: event.id, kind: event.kind,
    text: (event.delta ? (previous?.text ?? '') + event.text : event.text).slice(-8000) };
  if (previous) Object.assign(previous, next);
  else entries.push(next);
  if (entries.length > 100) entries.splice(0, entries.length - 100);
  let size = entries.reduce((sum, entry) => sum + entry.text.length, 0);
  while (size > 64000 && entries.length > 1) size -= entries.shift()!.text.length;
}

export function validateActivity(value: unknown): PlexActivity[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid Plex activity batch');
  return value.map(value => {
    const item = object(value);
    if (typeof item.id !== 'string' || !item.id || item.id.length > 300 ||
      !['user', 'assistant', 'tool', 'status'].includes(String(item.kind)) ||
      typeof item.text !== 'string' || item.text.length > 8000) throw new Error('Invalid Plex activity event');
    return { id: item.id, kind: item.kind as PlexActivity['kind'], text: item.text };
  });
}

export function readPlexTranscript(home: string): PlexTranscript {
  let manifest: { id?: unknown };
  try { manifest = JSON.parse(fs.readFileSync(path.join(home, 'plex-conversation.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], started: false, truncated: false };
    throw error;
  }
  if (typeof manifest.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(manifest.id)) {
    throw new Error('Invalid worker conversation manifest');
  }
  const file = path.join(home, 'session-state', manifest.id, 'events.jsonl');
  let fd: number;
  try { fd = fs.openSync(file, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], started: true, truncated: false };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - offset);
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    let content = buffer.toString('utf8', 0, read);
    if (offset) {
      const newline = content.indexOf('\n');
      content = newline < 0 ? '' : content.slice(newline + 1);
    }
    const entries: PlexActivity[] = [];
    let count = 0;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].trim()) continue;
      let record: unknown;
      try { record = JSON.parse(lines[index]); }
      catch {
        if (index === lines.length - 1) break; // The running CLI may be mid-append.
        throw new Error('Worker transcript contains a malformed event');
      }
      const event = copilotActivity(record);
      if (event) { count++; mergeActivity(entries, event); }
    }
    return { entries, started: true, truncated: offset > 0 || count > entries.length };
  } finally { fs.closeSync(fd); }
}

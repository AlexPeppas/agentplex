import type { ConversationEntry, ConversationSnapshot, ConversationUpdate } from './ipc-channels';

export const EMPTY_CONVERSATION: ConversationSnapshot = { entries: [], revision: 0, truncated: false };
const MAX_CONTENT = 64 * 1024;
const MAX_HISTORY = 512 * 1024;
const MAX_ENTRIES = 200;

export type ConversationInput = Omit<ConversationEntry, 'key'> & { key?: string };

function entrySize(entry: ConversationEntry) {
  return entry.text.length + (entry.detail?.length ?? 0) + entry.key.length + (entry.timestamp?.length ?? 0);
}

export function upsertConversation(snapshot: ConversationSnapshot, input: ConversationInput) {
  const revision = snapshot.revision + 1;
  const key = input.key ?? `entry:${revision}`;
  const previous = snapshot.entries.find(entry => entry.key === key);
  const text = input.text || previous?.text || (input.kind === 'tool' ? 'tool' : '');
  const detail = input.detail ?? previous?.detail;
  const entry: ConversationEntry = {
    ...previous, ...input, key, text: text.slice(0, MAX_CONTENT),
    ...(detail === undefined ? {} : { detail: detail.slice(0, MAX_CONTENT) }),
  };
  const entries = previous
    ? snapshot.entries.map(value => value.key === key ? entry : value)
    : [...snapshot.entries, entry];
  let size = entries.reduce((total, value) => total + entrySize(value), 0);
  let truncated = snapshot.truncated || text.length > MAX_CONTENT || (detail?.length ?? 0) > MAX_CONTENT;
  while (entries.length > MAX_ENTRIES || size > MAX_HISTORY) {
    const removed = entries.shift()!;
    size -= entrySize(removed);
    truncated = true;
  }
  return { entry, snapshot: { entries, revision, truncated } };
}

export function applyConversationUpdate(snapshot: ConversationSnapshot, update: ConversationUpdate): ConversationSnapshot {
  if (update.revision <= snapshot.revision) return snapshot;
  const next = upsertConversation(snapshot, update.entry).snapshot;
  return { ...next, revision: update.revision, truncated: next.truncated || update.truncated };
}

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { SessionStatus } from '../shared/ipc-channels';
import { CopilotLifecycle } from './copilot-lifecycle';

export interface AgentSpawnEvent {
  toolUseId: string;
  description: string;
  subagentType: string;
}

export interface AgentCompleteEvent {
  toolUseId: string;
}

/** Copilot only — fires when `session.plan_changed` event indicates plan creation/update. */
export interface PlanChangedEvent {
  operation: string;
}

/** Copilot only — fires when the agent requests interactive permission. */
export interface PermissionRequestedEvent {
  requestId: string;
  kind?: string;
  toolName?: string;
  description?: string;
  resource?: string;
  command?: string;
  managedApprovalRequired?: boolean;
}

/** Copilot only — fires when the user resolves a previous request. */
export interface PermissionCompletedEvent {
  requestId: string;
}

export function copilotPermissionRequest(data: Record<string, unknown>): PermissionRequestedEvent | null {
  if (typeof data.requestId !== 'string') return null;
  const raw = data.permissionRequest ?? data.request ?? data;
  const event: PermissionRequestedEvent = { requestId: data.requestId };
  if (!raw || typeof raw !== 'object') return event;
  const request = raw as Record<string, unknown>;
  const bounded = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.slice(0, 4000) : undefined;
  if (request.managedApprovalRequired === true) event.managedApprovalRequired = true;
  const details = {
    kind: bounded(request.kind), toolName: bounded(request.toolName ?? data.toolName),
    description: bounded(request.description ?? request.intention),
    resource: bounded(request.path ?? request.fileName ?? request.url),
    command: bounded(request.fullCommandText ?? request.command),
  };
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined) Object.assign(event, { [key]: value });
  }
  return event;
}

/** Copilot-only derived task list from sql(todo) operations. */
export interface TaskListEvent {
  tasks: { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }[];
}

export interface SessionTelemetryEvent {
  snapshotSource?: 'copilot-checkpoint' | 'copilot-shutdown' | 'copilot-compaction';
  contextTokens: number;
  contextWindowTokens: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string | null;
  updatedAt: number;
}

export type WatcherFormat = 'claude' | 'copilot';

function normalizeTodoStatus(statusRaw: string | undefined): 'pending' | 'in_progress' | 'completed' {
  const s = (statusRaw || '').trim().toLowerCase();
  if (s === 'done' || s === 'completed' || s === 'complete') return 'completed';
  if (s === 'in_progress' || s === 'in progress' || s === 'active' || s === 'running') return 'in_progress';
  return 'pending';
}

function parseSqlStrings(text: string): string[] {
  const out: string[] = [];
  const re = /'((?:''|[^'])*)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push(match[1].replace(/''/g, "'"));
  }
  return out;
}

function splitSqlStatements(query: string): string[] {
  const statements: string[] = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < query.length; i++) {
    const ch = query[i];
    if (quote) {
      current += ch;
      if (ch === quote) {
        if (query[i + 1] === quote) current += query[++i];
        else quote = '';
      }
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      current += ch;
    } else if (ch === '-' && query[i + 1] === '-') {
      while (i < query.length && query[i] !== '\n') i++;
      current += ' ';
    } else if (ch === '/' && query[i + 1] === '*') {
      i += 2;
      while (i < query.length && !(query[i] === '*' && query[i + 1] === '/')) i++;
      i++;
      current += ' ';
    } else if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseSqlCsv(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      current += ch;
      if (inQuote && text[i + 1] === "'") {
        current += "'";
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === ',' && !inQuote) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function extractSqlTuples(text: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let inQuote = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'") {
      if (inQuote && text[i + 1] === "'") {
        if (depth > 0) current += "''";
        i++;
      } else {
        inQuote = !inQuote;
        if (depth > 0) current += ch;
      }
      continue;
    }
    if (inQuote) {
      if (depth > 0) current += ch;
      continue;
    }
    if (ch === '(') {
      depth++;
      if (depth === 1) {
        current = '';
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === ')') {
      if (depth > 1) {
        current += ch;
      } else if (depth === 1) {
        tuples.push(current.trim());
        current = '';
      }
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) current += ch;
  }
  return tuples;
}

export class JsonlSessionWatcher extends EventEmitter {
  /** Claude uses mtime as a fallback; Copilot exposes structured lifecycleStatus. */
  jsonlPath: string;
  private format: WatcherFormat;
  private offset = 0;
  private partialLine = '';
  private activeAgents = new Map<string, { description: string; subagentType: string }>();
  private seenAgentIds = new Set<string>();
  private copilotTasksById = new Map<string, { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }>();
  private nextCopilotTaskNumber = 1;
  private pendingTodoSql = new Map<string, string>();
  private telemetry: SessionTelemetryEvent | null = null;
  private copilotLifecycle = new CopilotLifecycle();
  private lastLifecycleStatus: SessionStatus | null = null;
  private readSinceStart = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** When true, prime the read offset to the current end-of-file on start so
   *  pre-existing content (a resumed/restored session's history) is NOT replayed
   *  as fresh sub-agent/plan/task events. Only genuinely new appends are emitted. */
  private skipExisting: boolean;

  constructor(jsonlPath: string, format: WatcherFormat = 'claude', skipExisting = false, private hydrateLifecycle = false) {
    super();
    this.jsonlPath = jsonlPath;
    this.format = format;
    this.skipExisting = skipExisting;
  }

  get lifecycleStatus(): SessionStatus | null {
    return this.format === 'copilot' ? this.copilotLifecycle.status : null;
  }

  start(): void {
    if (this.timer) return;
    this.readSinceStart = false;
    if (this.skipExisting) {
      // Skip any content that already exists on disk (resume/restore): only
      // events appended after this point should render sub-agents/plans/tasks.
      try {
        this.offset = fs.statSync(this.jsonlPath).size;
      } catch (error) {
        // File doesn't exist yet (genuinely new session) — read from the start.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    this.timer = setInterval(() => {
      try { this.poll(); }
      catch (error) {
        this.stop();
        if (this.listenerCount('watch-error')) this.emit('watch-error', error);
        else console.error('[session-watcher] Cannot read provider events:', error);
      }
    }, 500);
    const snapshotEnd = this.offset;
    queueMicrotask(() => {
      if (!this.timer) return;
      if (this.skipExisting) {
        try {
          if (this.format === 'copilot') this.hydrateCopilotTasks(snapshotEnd);
          this.readLatestTelemetry(snapshotEnd);
        } catch (error) {
          this.stop();
          if (this.listenerCount('watch-error')) this.emit('watch-error', error);
          else console.error('[session-watcher] Cannot hydrate provider events:', error);
          return;
        }
      }
      this.publishLifecycle();
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Drain the final append before an owning subprocess exits and stops watching. */
  flush(final = false): void {
    this.poll();
    if (final && this.readSinceStart && this.partialLine.trim()) {
      this.processLine(this.partialLine.trim());
      this.partialLine = '';
      this.publishLifecycle();
    }
  }

  private poll(): void {
    let fd: number;
    try {
      fd = fs.openSync(this.jsonlPath, 'r');
    } catch (error) {
      // File doesn't exist yet — normal during startup
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return;
    }

    try {
      const stat = fs.fstatSync(fd);
      if (stat.size < this.offset) {
        // The CLI truncated or replaced the events file. Continuing from the
        // stale byte offset would permanently miss new events and eventually
        // resume in the middle of a JSON record.
        this.offset = 0;
        this.partialLine = '';
        this.pendingTodoSql.clear();
        this.copilotTasksById.clear();
        this.nextCopilotTaskNumber = 1;
        if (this.format === 'copilot') this.emit('task-list', { tasks: [] } satisfies TaskListEvent);
        this.copilotLifecycle.reset();
        this.publishLifecycle();
      }
      if (stat.size === this.offset) return;

      const bytesToRead = stat.size - this.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      this.offset = stat.size;
      this.readSinceStart = true;

      const chunk = this.partialLine + buf.toString('utf-8');
      const lines = chunk.split('\n');

      // Last element is either empty (line ended with \n) or a partial line
      this.partialLine = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.processLine(trimmed);
      }
      // Publish the final state of the batch: turn_end/turn_start often arrive
      // together between tool rounds and should not flash Idle in the renderer.
      this.publishLifecycle();
    } finally {
      fs.closeSync(fd);
    }
  }

  private processLine(line: string): void {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return; // malformed line
    }

    if (!record || typeof record !== 'object') return;
    if (this.format === 'claude') this.processClaudeRecord(record);
    else this.processCopilotRecord(record);
  }

  private hydrateCopilotTasks(snapshotEnd: number): void {
    let fd: number;
    try {
      fd = fs.openSync(this.jsonlPath, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    try {
      this.pendingTodoSql.clear();
      this.copilotTasksById.clear();
      this.nextCopilotTaskNumber = 1;
      const decoder = new StringDecoder('utf8');
      const buffer = Buffer.alloc(64 * 1024);
      const end = Math.min(snapshotEnd, fs.fstatSync(fd).size);
      let offset = 0;
      let partial = '';
      while (offset < end) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (!count) break;
        offset += count;
        const lines = (partial + decoder.write(buffer.subarray(0, count))).split('\n');
        partial = lines.pop() || '';
        for (const line of lines) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          this.processCopilotTodoRecord(record);
        }
      }
      this.emit('task-list', { tasks: this.getCopilotTaskList() } satisfies TaskListEvent);
    } finally {
      fs.closeSync(fd);
    }
  }

  private processCopilotTodoRecord(record: any): boolean {
    const data = record?.data;
    if (!data || typeof data.toolCallId !== 'string') return false;
    if (record.type === 'tool.execution_start' && data.toolName === 'sql' &&
      typeof data.arguments?.query === 'string') {
      this.pendingTodoSql.set(data.toolCallId, data.arguments.query);
    } else if (record.type === 'tool.execution_complete') {
      const query = this.pendingTodoSql.get(data.toolCallId);
      this.pendingTodoSql.delete(data.toolCallId);
      if (query && data.success === true) return this.applyCopilotTodoSql(query);
    }
    return false;
  }

  /** Read only the captured tail for usage and, when attaching to an already
   * running CLI, lifecycle state. Never replay historical UI action events. */
  private readLatestTelemetry(snapshotEnd: number): void {
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.jsonlPath, 'r');
      const stat = fs.fstatSync(fd);
      const end = Math.min(stat.size, snapshotEnd);
      if (end === 0) return;
      const maxBytes = 2 * 1024 * 1024;
      const start = Math.max(0, end - maxBytes);
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf-8');
      if (start > 0) {
        const firstNewline = text.indexOf('\n');
        if (firstNewline < 0) return;
        text = text.slice(firstNewline + 1);
      }
      const lines = text.split('\n');
      // Preserve an incomplete record across the startup offset, just as poll()
      // preserves partial records across subsequent reads.
      this.partialLine = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed);
          if (!record || typeof record !== 'object') continue;
          if (this.format === 'claude') this.processClaudeTelemetry(record);
          else {
            this.processCopilotTelemetry(record);
            if (this.hydrateLifecycle) this.copilotLifecycle.accept(record);
          }
        } catch {
          // Ignore malformed or partially-written tail records.
        }
      }
    } catch {
      // The provider log may not exist yet for a new session.
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private publishLifecycle(): void {
    const status = this.lifecycleStatus;
    if (status === null || status === this.lastLifecycleStatus) return;
    this.lastLifecycleStatus = status;
    this.emit('lifecycle', status);
  }

  private emitTelemetry(next: Partial<SessionTelemetryEvent>): void {
    const previous = this.telemetry;
    const merged: SessionTelemetryEvent = {
      contextTokens: next.contextTokens ?? previous?.contextTokens ?? 0,
      contextWindowTokens: next.contextWindowTokens !== undefined ? next.contextWindowTokens : previous?.contextWindowTokens ?? null,
      inputTokens: next.inputTokens ?? previous?.inputTokens ?? 0,
      outputTokens: next.outputTokens ?? previous?.outputTokens ?? 0,
      cacheReadTokens: next.cacheReadTokens ?? previous?.cacheReadTokens ?? 0,
      cacheWriteTokens: next.cacheWriteTokens ?? previous?.cacheWriteTokens ?? 0,
      model: next.model !== undefined ? next.model : previous?.model ?? null,
      updatedAt: next.updatedAt ?? Date.now(),
      snapshotSource: next.snapshotSource,
    };
    this.telemetry = merged;
    this.emit('telemetry', merged);
  }

  private processClaudeTelemetry(record: any): void {
    if (record.type !== 'assistant') return;
    const usage = record.message?.usage;
    if (!usage || typeof usage !== 'object') return;
    const inputTokens = Number(usage.input_tokens) || 0;
    const cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
    const cacheWriteTokens = Number(usage.cache_creation_input_tokens) || 0;
    this.emitTelemetry({
      contextTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      contextWindowTokens: 200_000,
      inputTokens,
      outputTokens: Number(usage.output_tokens) || 0,
      cacheReadTokens,
      cacheWriteTokens,
      model: typeof record.message?.model === 'string' ? record.message.model : null,
      updatedAt: typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || Date.now() : Date.now(),
    });
  }

  private processCopilotTelemetry(record: any): void {
    const data = record.data;
    if (!data || typeof data !== 'object') return;

    // model.* includes title generation, routing and other auxiliary requests.
    // Even a matching model ID does not prove that a call is the main context.
    const validTokens = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const timestamp = Date.parse(record.timestamp);
    if (!Number.isFinite(timestamp)) return;

    if (record.type === 'session.usage_checkpoint') {
      const main = Array.isArray(data.promptCacheBreakState)
        ? data.promptCacheBreakState.find((entry: any) => entry?.conversation === 'main')
        : undefined;
      const model = main?.lastActiveModel;
      const snapshot = typeof model === 'string' ? main?.models?.[model] : undefined;
      const completedAt = Date.parse(snapshot?.completed_at);
      if (!snapshot || !validTokens(snapshot.prompt_tokens) || !Number.isFinite(completedAt)) return;
      // Checkpoints can retain old model cache entries after compaction.
      if (this.telemetry && completedAt <= this.telemetry.updatedAt) return;
      const cached = validTokens(snapshot.cache_read) ? snapshot.cache_read : 0;
      const written = validTokens(snapshot.cache_write) ? snapshot.cache_write : 0;
      this.emitTelemetry({
        contextTokens: snapshot.prompt_tokens,
        contextWindowTokens: null,
        inputTokens: Math.max(0, snapshot.prompt_tokens - cached - written),
        outputTokens: 0,
        cacheReadTokens: cached,
        cacheWriteTokens: written,
        model,
        updatedAt: completedAt,
        snapshotSource: 'copilot-checkpoint',
      });
      return;
    }

    const shutdown = record.type === 'session.shutdown';
    const compacted = record.type === 'session.compaction_complete' && data.success === true;
    const tokens = shutdown ? data.currentTokens : data.postCompactionTokens;
    if ((shutdown || compacted) && validTokens(tokens)) {
      if (this.telemetry && timestamp < this.telemetry.updatedAt) return;
      this.emitTelemetry({
        contextTokens: tokens,
        // Compaction's tokenLimit is a trigger threshold, not necessarily
        // the provider's context-window capacity.
        contextWindowTokens: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: shutdown && typeof data.currentModel === 'string' ? data.currentModel : null,
        updatedAt: timestamp,
        snapshotSource: shutdown ? 'copilot-shutdown' : 'copilot-compaction',
      });
    }
  }

  private processClaudeRecord(record: any): void {
    this.processClaudeTelemetry(record);
    const type = record.type;
    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    if (type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Agent') {
          const toolUseId: string = block.id;
          if (this.seenAgentIds.has(toolUseId)) continue;
          this.seenAgentIds.add(toolUseId);
          const description: string = block.input?.description || 'Sub-agent';
          const subagentType: string = block.input?.subagent_type || 'general-purpose';

          this.activeAgents.set(toolUseId, { description, subagentType });
          this.emit('agent-spawn', { toolUseId, description, subagentType } satisfies AgentSpawnEvent);
        }
      }
    } else if (type === 'user') {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const toolUseId: string = block.tool_use_id;
          if (this.activeAgents.has(toolUseId)) {
            this.activeAgents.delete(toolUseId);
            this.emit('agent-complete', { toolUseId } satisfies AgentCompleteEvent);
          }
        }
      }
    }
  }

  /**
   * Copilot's events.jsonl uses a flat event-typed format. Mappings:
   *   - `subagent.started` → agent-spawn (toolCallId is the spawn id).
   *     There's no explicit `subagent.completed`; completion comes from
   *     `tool.execution_complete` with the matching toolCallId (the underlying
   *     tool call is `task`).
   *   - `session.plan_changed` → plan-changed (create/update) or plan-deleted.
   *     The plan title lives in `<session-state>/plan.md`; the listener reads
   *     that file to extract the heading.
   *   - `permission.requested` / `permission.completed` → drive WaitingForInput
   *     status immediately (avoids the 500ms terminal-pattern poll lag).
   */
  private processCopilotRecord(record: any): void {
    this.copilotLifecycle.accept(record);
    this.processCopilotTelemetry(record);
    const type = record.type;
    const data = record.data;
    if (!type || !data || typeof data !== 'object') return;

    if (this.processCopilotTodoRecord(record)) {
      this.emit('task-list', { tasks: this.getCopilotTaskList() } satisfies TaskListEvent);
    }
    if (type === 'subagent.started') {
      const toolUseId: string | undefined = data.toolCallId;
      if (typeof toolUseId !== 'string') return;
      if (this.seenAgentIds.has(toolUseId)) return;
      this.seenAgentIds.add(toolUseId);
      const description: string =
        data.agentDescription || data.agentDisplayName || data.agentName || 'Sub-agent';
      const subagentType: string = data.agentName || 'general-purpose';
      this.activeAgents.set(toolUseId, { description, subagentType });
      this.emit('agent-spawn', { toolUseId, description, subagentType } satisfies AgentSpawnEvent);
    } else if (type === 'tool.execution_complete') {
      const toolUseId: string | undefined = data.toolCallId;
      if (typeof toolUseId !== 'string') return;
      // Only emit complete if we tracked a spawn for this id — filters out non-task tool calls.
      if (this.activeAgents.has(toolUseId)) {
        this.activeAgents.delete(toolUseId);
        this.emit('agent-complete', { toolUseId } satisfies AgentCompleteEvent);
      }
    } else if (type === 'session.plan_changed') {
      const operation: string = typeof data.operation === 'string' ? data.operation : 'create';
      if (operation === 'delete') {
        this.emit('plan-deleted');
      } else {
        // create / update / anything else → re-read plan.md
        this.emit('plan-changed', { operation } satisfies PlanChangedEvent);
      }
    } else if (type === 'permission.requested') {
      const event = copilotPermissionRequest(data);
      if (event) this.emit('permission-requested', event);
    } else if (type === 'permission.completed') {
      const requestId: string | undefined = data.requestId;
      if (typeof requestId !== 'string') return;
      this.emit('permission-completed', { requestId } satisfies PermissionCompletedEvent);
    }
  }

  private getCopilotTaskList(): { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }[] {
    return Array.from(this.copilotTasksById.values())
      .sort((a, b) => a.taskNumber - b.taskNumber)
      .map((t) => ({ taskNumber: t.taskNumber, description: t.description, status: t.status }));
  }

  private applyCopilotTodoSql(query: string): boolean {
    let changed = false;
    for (const statement of splitSqlStatements(query)) {
      changed = this.applyCopilotTodoStatement(statement) || changed;
    }
    return changed;
  }

  private applyCopilotTodoStatement(query: string): boolean {
    let changed = false;

    // INSERT INTO todos (...) VALUES (...), (...)
    const insertRe = /^insert\s+(?:or\s+(?:replace|ignore)\s+)?into\s+todos\s*\(([\s\S]*?)\)\s*values\s*([\s\S]*)$/gi;
    let insertMatch: RegExpExecArray | null;
    while ((insertMatch = insertRe.exec(query)) !== null) {
      const columns = insertMatch[1].split(',').map((c: string) => c.trim().toLowerCase());
      const tuples = extractSqlTuples(insertMatch[2]);
      for (const tuple of tuples) {
        const values = parseSqlCsv(tuple);
        const row: Record<string, string> = {};
        for (let i = 0; i < columns.length && i < values.length; i++) {
          const val = values[i];
          const m = val.match(/^'((?:''|[^'])*)'$/);
          row[columns[i]] = m ? m[1].replace(/''/g, "'") : val;
        }
        const id = row.id;
        if (!id) continue;
        const current = this.copilotTasksById.get(id);
        if (current && /^insert\s+or\s+ignore\b/i.test(query)) continue;
        const taskNumber = current?.taskNumber ?? this.nextCopilotTaskNumber++;
        const description = (row.title || row.description || current?.description || id).trim();
        const status = normalizeTodoStatus(row.status || current?.status);
        this.copilotTasksById.set(id, { taskNumber, description, status });
        changed = true;
      }
    }

    // UPDATE todos SET ... WHERE ... (status mutations)
    const updateRe = /^update\s+todos\s+set\s+([\s\S]*?)\s+where\s+([\s\S]*)$/gi;
    let updateMatch: RegExpExecArray | null;
    while ((updateMatch = updateRe.exec(query)) !== null) {
      const setPart = updateMatch[1];
      const wherePart = updateMatch[2];
      const statusMatch = setPart.match(/status\s*=\s*'((?:''|[^'])*)'/i);
      if (!statusMatch) continue;
      const nextStatus = normalizeTodoStatus(statusMatch[1].replace(/''/g, "'"));

      const ids = new Set<string>();
      const inMatch = wherePart.match(/id\s+in\s*\(([\s\S]*?)\)/i);
      if (inMatch) {
        for (const id of parseSqlStrings(inMatch[1])) ids.add(id);
      }
      const eqMatch = wherePart.match(/id\s*=\s*'((?:''|[^'])*)'/i);
      if (eqMatch) ids.add(eqMatch[1].replace(/''/g, "'"));

      for (const id of ids) {
        const current = this.copilotTasksById.get(id);
        if (!current) continue;
        if (current.status !== nextStatus) {
          this.copilotTasksById.set(id, { ...current, status: nextStatus });
          changed = true;
        }
      }
    }

    // DELETE FROM todos;
    if (/^delete\s+from\s+todos\s*$/i.test(query)) {
      if (this.copilotTasksById.size > 0) {
        this.copilotTasksById.clear();
        this.nextCopilotTaskNumber = 1;
        changed = true;
      }
    }

    // DELETE FROM todos WHERE id ...
    const deleteRe = /^delete\s+from\s+todos\s+where\s+([\s\S]*)$/gi;
    let deleteMatch: RegExpExecArray | null;
    while ((deleteMatch = deleteRe.exec(query)) !== null) {
      const wherePart = deleteMatch[1];
      const ids = new Set<string>();
      const inMatch = wherePart.match(/id\s+in\s*\(([\s\S]*?)\)/i);
      if (inMatch) {
        for (const id of parseSqlStrings(inMatch[1])) ids.add(id);
      }
      const eqMatch = wherePart.match(/id\s*=\s*'((?:''|[^'])*)'/i);
      if (eqMatch) ids.add(eqMatch[1].replace(/''/g, "'"));
      for (const id of ids) {
        if (this.copilotTasksById.delete(id)) changed = true;
      }
    }

    return changed;
  }
}

/**
 * Encode a working directory path the same way Claude CLI does for the projects folder.
 * C:\Users\foo\project → C--Users-foo-project
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/.:]/g, '-');
}

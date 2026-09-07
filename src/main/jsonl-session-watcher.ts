import { EventEmitter } from 'events';
import * as fs from 'fs';
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
}

/** Copilot only — fires when the user resolves a previous request. */
export interface PermissionCompletedEvent {
  requestId: string;
}

/** Copilot-only derived task list from sql(todo) operations. */
export interface TaskListEvent {
  tasks: { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }[];
}

export interface SessionTelemetryEvent {
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
  private telemetry: SessionTelemetryEvent | null = null;
  private copilotLifecycle = new CopilotLifecycle();
  private lastLifecycleStatus: SessionStatus | null = null;
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
    if (this.skipExisting) {
      // Skip any content that already exists on disk (resume/restore): only
      // events appended after this point should render sub-agents/plans/tasks.
      try {
        this.offset = fs.statSync(this.jsonlPath).size;
      } catch {
        // File doesn't exist yet (genuinely new session) — read from the start.
      }
    }
    this.timer = setInterval(() => this.poll(), 500);
    const snapshotEnd = this.offset;
    queueMicrotask(() => {
      if (!this.timer) return;
      if (this.skipExisting) this.readLatestTelemetry(snapshotEnd);
      this.publishLifecycle();
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    let fd: number;
    try {
      fd = fs.openSync(this.jsonlPath, 'r');
    } catch {
      // File doesn't exist yet — normal during startup
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
        this.copilotLifecycle.reset();
        this.publishLifecycle();
      }
      if (stat.size === this.offset) return;

      const bytesToRead = stat.size - this.offset;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      this.offset = stat.size;

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
      contextWindowTokens: next.contextWindowTokens ?? previous?.contextWindowTokens ?? null,
      inputTokens: next.inputTokens ?? previous?.inputTokens ?? 0,
      outputTokens: next.outputTokens ?? previous?.outputTokens ?? 0,
      cacheReadTokens: next.cacheReadTokens ?? previous?.cacheReadTokens ?? 0,
      cacheWriteTokens: next.cacheWriteTokens ?? previous?.cacheWriteTokens ?? 0,
      model: next.model ?? previous?.model ?? null,
      updatedAt: next.updatedAt ?? Date.now(),
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

    if ((record.type === 'model.turn_started' || record.type === 'model.model_call_started') && data.modelInfo) {
      const limit = Number(data.modelInfo?.capabilities?.limits?.max_context_window_tokens);
      this.emitTelemetry({
        contextWindowTokens: Number.isFinite(limit) && limit > 0 ? limit : null,
        model: typeof data.model === 'string' ? data.model : null,
        updatedAt: Number(data.timestampMs) || Date.now(),
      });
      return;
    }

    if (record.type === 'model.model_call_success') {
      const usage = data.responseUsage;
      if (!usage || typeof usage !== 'object') return;
      const promptTokens = Number(usage.prompt_tokens) || 0;
      this.emitTelemetry({
        contextTokens: promptTokens,
        inputTokens: Math.max(0, promptTokens - (Number(usage.prompt_tokens_details?.cached_tokens) || 0)),
        outputTokens: Number(usage.completion_tokens) || 0,
        cacheReadTokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
        cacheWriteTokens: 0,
        model: typeof data.modelCall?.model === 'string' ? data.modelCall.model : null,
        updatedAt: typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || Date.now() : Date.now(),
      });
      return;
    }

    if (record.type === 'session.shutdown') {
      const details = data.tokenDetails;
      const currentTokens = Number(data.currentTokens);
      if (!details || !Number.isFinite(currentTokens)) return;
      this.emitTelemetry({
        contextTokens: currentTokens,
        inputTokens: Number(details.input?.tokenCount) || 0,
        outputTokens: Number(details.output?.tokenCount) || 0,
        cacheReadTokens: Number(details.cache_read?.tokenCount) || 0,
        cacheWriteTokens: Number(details.cache_write?.tokenCount) || 0,
        model: typeof data.currentModel === 'string' ? data.currentModel : null,
        updatedAt: typeof record.timestamp === 'string' ? Date.parse(record.timestamp) || Date.now() : Date.now(),
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

    if (type === 'tool.execution_start') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : '';
      const query = typeof data.arguments?.query === 'string' ? data.arguments.query : '';
      if (toolName === 'sql' && query && this.applyCopilotTodoSql(query)) {
        this.emit('task-list', { tasks: this.getCopilotTaskList() } satisfies TaskListEvent);
      }
    } else if (type === 'subagent.started') {
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
      const requestId: string | undefined = data.requestId;
      if (typeof requestId !== 'string') return;
      this.emit('permission-requested', { requestId } satisfies PermissionRequestedEvent);
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

    // INSERT INTO todos (...) VALUES (...), (...)
    const insertRe = /insert\s+into\s+todos\s*\(([\s\S]*?)\)\s*values\s*([\s\S]*?)(?:;|$)/gi;
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
        const taskNumber = current?.taskNumber ?? this.nextCopilotTaskNumber++;
        const description = (row.title || row.description || current?.description || id).trim();
        const status = normalizeTodoStatus(row.status || current?.status);
        this.copilotTasksById.set(id, { taskNumber, description, status });
        changed = true;
      }
    }

    // UPDATE todos SET ... WHERE ... (status mutations)
    const updateRe = /update\s+todos\s+set\s+([\s\S]*?)\s+where\s+([\s\S]*?)(?:;|$)/gi;
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
    if (/delete\s+from\s+todos\s*;/i.test(query)) {
      if (this.copilotTasksById.size > 0) {
        this.copilotTasksById.clear();
        this.nextCopilotTaskNumber = 1;
        changed = true;
      }
    }

    // DELETE FROM todos WHERE id ...
    const deleteRe = /delete\s+from\s+todos\s+where\s+([\s\S]*?)(?:;|$)/gi;
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

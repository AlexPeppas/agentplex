import { EventEmitter } from 'events';
import * as fs from 'fs';

export interface AgentSpawnEvent {
  toolUseId: string;
  description: string;
  subagentType: string;
}

export interface AgentCompleteEvent {
  toolUseId: string;
}

export type WatcherFormat = 'claude' | 'copilot';

export class JsonlSessionWatcher extends EventEmitter {
  /** Public so SessionManager can read mtime for "Running" status detection. */
  jsonlPath: string;
  private format: WatcherFormat;
  private offset = 0;
  private partialLine = '';
  private activeAgents = new Map<string, { description: string; subagentType: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(jsonlPath: string, format: WatcherFormat = 'claude') {
    super();
    this.jsonlPath = jsonlPath;
    this.format = format;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), 500);
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
      if (stat.size <= this.offset) return;

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

    if (this.format === 'claude') this.processClaudeRecord(record);
    else this.processCopilotRecord(record);
  }

  private processClaudeRecord(record: any): void {
    const type = record.type;
    const content = record.message?.content;
    if (!Array.isArray(content)) return;

    if (type === 'assistant') {
      for (const block of content) {
        if (block.type === 'tool_use' && block.name === 'Agent') {
          const toolUseId: string = block.id;
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
   * Copilot's events.jsonl uses a flat event-typed format. Sub-agents:
   *   - `subagent.started` carries `data.toolCallId`, `data.agentName`, `data.agentDisplayName`,
   *     `data.agentDescription`. There is no explicit `subagent.completed` event;
   *     completion is signaled by `tool.execution_complete` with the matching `toolCallId`
   *     (the underlying tool call is `task`).
   */
  private processCopilotRecord(record: any): void {
    const type = record.type;
    const data = record.data;
    if (!type || !data || typeof data !== 'object') return;

    if (type === 'subagent.started') {
      const toolUseId: string | undefined = data.toolCallId;
      if (typeof toolUseId !== 'string') return;
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
    }
  }
}

/**
 * Encode a working directory path the same way Claude CLI does for the projects folder.
 * C:\Users\foo\project → C--Users-foo-project
 */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[\\/.:]/g, '-');
}

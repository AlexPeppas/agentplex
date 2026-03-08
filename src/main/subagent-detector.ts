import { stripAnsi } from '../shared/ansi-strip';

export interface SubagentEvent {
  type: 'spawn' | 'complete';
  subagentId: string;
  description: string;
}

type SubagentCallback = (event: SubagentEvent) => void;

let idCounter = 0;

// Individual sub-agent entry in the parallel-agents tree view:
//   ├─ Explore compliance docx and txt · 2 tool uses · 12.1k tokens
//   └─ Explore drawio diagram PNG · 0 tool uses · 11.1k tokens
const SUBAGENT_ENTRY_RE = /[├└]─\s+(.+?)\s+·/;

// Header when all parallel agents complete:  ● Completed 3 Explore agents
const COMPLETED_RE = /[●⏺]\s*Completed\s+\d+/;

// Single-agent spawn:  ⏺ Agent "description"  or  ● Agent(description)
const SINGLE_SPAWN_RE = /[⏺●]\s*Agent\b[\s(:]*(.+)/;

// Single-agent completion:  ⎿ Agent result
const SINGLE_COMPLETE_RE = /⎿\s*Agent\b/;

export class SubagentDetector {
  private buffer = '';
  private callback: SubagentCallback;
  private stack: { id: string; description: string }[] = [];
  private seenDescriptions = new Set<string>();

  constructor(callback: SubagentCallback) {
    this.callback = callback;
  }

  feed(data: string): void {
    this.buffer += data;

    // Process complete lines only
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      // Handle \r within the line (in-place terminal redraws)
      const segments = rawLine.split('\r');
      for (const segment of segments) {
        this.processLine(segment);
      }
    }
  }

  private processLine(rawLine: string): void {
    const line = stripAnsi(rawLine).trim();
    if (!line) return;

    // Parallel agents: individual sub-agent entry (├─ or └─ lines with · separator)
    const entryMatch = line.match(SUBAGENT_ENTRY_RE);
    if (entryMatch) {
      const description = entryMatch[1].trim();
      // Deduplicate — the CLI redraws these lines as stats update
      if (!this.seenDescriptions.has(description)) {
        this.seenDescriptions.add(description);
        idCounter++;
        const subagentId = `subagent-${idCounter}`;
        this.stack.push({ id: subagentId, description });
        this.callback({ type: 'spawn', subagentId, description });
      }
      return;
    }

    // Parallel agents: completion header
    if (COMPLETED_RE.test(line) && this.stack.length > 0) {
      while (this.stack.length > 0) {
        const completed = this.stack.pop()!;
        this.seenDescriptions.delete(completed.description);
        this.callback({
          type: 'complete',
          subagentId: completed.id,
          description: completed.description,
        });
      }
      return;
    }

    // Single agent spawn
    const singleMatch = line.match(SINGLE_SPAWN_RE);
    if (singleMatch) {
      const rawDesc = singleMatch[1].replace(/[)"]+$/, '').trim() || 'Sub-agent';

      // Lines like '● Agent "name" completed' or '● Agent A is done' are
      // completion/status messages, not new spawns
      if (/\bcompleted\b|\bis done\b/i.test(rawDesc)) {
        if (this.stack.length > 0) {
          const completed = this.stack.pop()!;
          this.seenDescriptions.delete(completed.description);
          this.callback({
            type: 'complete',
            subagentId: completed.id,
            description: completed.description,
          });
        }
        return;
      }

      // Deduplicate — terminal redraws repeat the same spawn line
      if (this.seenDescriptions.has(rawDesc)) return;
      this.seenDescriptions.add(rawDesc);

      idCounter++;
      const subagentId = `subagent-${idCounter}`;
      this.stack.push({ id: subagentId, description: rawDesc });
      this.callback({ type: 'spawn', subagentId, description: rawDesc });
      return;
    }

    // Single agent completion
    if (SINGLE_COMPLETE_RE.test(line) && this.stack.length > 0) {
      const completed = this.stack.pop()!;
      this.seenDescriptions.delete(completed.description);
      this.callback({
        type: 'complete',
        subagentId: completed.id,
        description: completed.description,
      });
    }
  }
}

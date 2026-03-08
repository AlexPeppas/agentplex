import { stripAnsi } from '../shared/ansi-strip';

export type PlanTaskEvent =
  | { type: 'plan-enter'; planSlug: string | null }
  | { type: 'plan-exit' }
  | { type: 'task-create'; taskNumber: number; description: string }
  | { type: 'task-update'; taskNumber: number; status: 'pending' | 'in_progress' | 'completed' }
  | { type: 'task-list'; tasks: { taskNumber: number; description: string; status: 'pending' | 'in_progress' | 'completed' }[] };

type PlanTaskCallback = (event: PlanTaskEvent) => void;
type TaskStatus = 'pending' | 'in_progress' | 'completed';

const PLAN_ENTER_RE = /plan mode on/i;
const PLAN_EXIT_RE = /plan mode off|auto mode|normal mode/i;
const PLAN_SLUG_RE = /\.claude[/\\]plans[/\\]([\w-]+)\.md/;

// Tool result formats
const TASK_CREATE_RE = /Task\s+#(\d+)\s+created.*?:\s+(.+)/;
const TASK_UPDATE_RE = /Updated\s+task\s+#(\d+)\s+status/;

// Task list header: "2 tasks (0 done, 1 in progress, 1 open)"
const TASK_LIST_HEADER_RE = /(\d+)\s+tasks?\s+\(/;

// Broad character class for task status symbols (Unicode escapes for certainty).
// Covers: ballot boxes, checkmarks, geometric squares & circles (filled & empty)
const SYM =
  '[\u2610-\u2612' +   // ☐ ☑ ☒
  '\u2705' +            // ✅
  '\u2713\u2714' +      // ✓ ✔
  '\u25A0-\u25A2' +     // ■ □ ▢
  '\u25AA\u25AB' +      // ▪ ▫
  '\u25C9\u25CB' +      // ◉ ○
  '\u25EF' +            // ◯
  '\u25FB-\u25FE' +     // ◻ ◼ ◽ ◾
  '\u2B1B\u2B1C]';      // ⬛ ⬜

// Global regex: finds one or more "symbol + space + description" on a line.
// Lookahead stops the lazy description capture at the next symbol or line end.
const TASK_ENTRY_G = new RegExp(
  '(' + SYM + ')\\s+(\\S.*?)(?=\\s+' + SYM + '|\\s*$)',
  'g',
);

// Quick test: does the line contain at least one task symbol?
const HAS_TASK_SYMBOL = new RegExp(SYM);

function classifySymbol(ch: string): TaskStatus {
  const c = ch.codePointAt(0)!;
  // Checkmarks → completed
  if (c === 0x2713 || c === 0x2714 || c === 0x2705 || c === 0x2611 || c === 0x2612) return 'completed';
  // Filled shapes → in_progress
  if (c === 0x25A0 || c === 0x25AA || c === 0x25FC || c === 0x25FE || c === 0x25C9 || c === 0x2B1B) return 'in_progress';
  // Empty/outline shapes → pending (default)
  return 'pending';
}

export class PlanTaskDetector {
  private buffer = '';
  private callback: PlanTaskCallback;
  private inPlan = false;

  constructor(callback: PlanTaskCallback) {
    this.callback = callback;
  }

  feed(data: string): void {
    this.buffer += data;

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const rawLine = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);

      const segments = rawLine.split('\r');
      for (const segment of segments) {
        this.processLine(segment);
      }
    }
  }

  private processLine(rawLine: string): void {
    const stripped = stripAnsi(rawLine).trim();
    if (!stripped) return;

    // Strip leading box-drawing prefixes (│, ├─, └─) used in nested displays
    const line = stripped.replace(/^([│|]\s*)+/, '').replace(/^[├└]─\s*/, '');
    if (!line) return;

    // Plan enter
    if (!this.inPlan && PLAN_ENTER_RE.test(line)) {
      this.inPlan = true;
      const slugMatch = line.match(PLAN_SLUG_RE);
      this.callback({ type: 'plan-enter', planSlug: slugMatch ? slugMatch[1] : null });
      return;
    }

    // Plan slug on a separate line
    if (this.inPlan) {
      const slugMatch = line.match(PLAN_SLUG_RE);
      if (slugMatch) {
        this.callback({ type: 'plan-enter', planSlug: slugMatch[1] });
        return;
      }
    }

    // Plan exit
    if (this.inPlan && PLAN_EXIT_RE.test(line)) {
      this.inPlan = false;
      this.callback({ type: 'plan-exit' });
      return;
    }

    // Task list header — resets sequential counter
    if (TASK_LIST_HEADER_RE.test(line)) {
      this.taskEntryCounter = 0;
      return;
    }

    // Task entries with status symbols (supports multiple per line)
    if (HAS_TASK_SYMBOL.test(line)) {
      TASK_ENTRY_G.lastIndex = 0;
      let match: RegExpExecArray | null;
      let found = false;
      while ((match = TASK_ENTRY_G.exec(line)) !== null) {
        const symbol = match[1];
        // Strip "› blocked by ..." suffix from description
        const description = match[2].replace(/\s+[\u203A>]\s+blocked\b.*$/, '').trim();
        if (!description || /^[\s\-\u2014\u2013_.…·:]+$/.test(description)) continue;
        const status = classifySymbol(symbol);
        this.taskEntryCounter++;
        this.emitTaskListEntry(this.taskEntryCounter, status, description);
        found = true;
      }
      if (found) return;
    }

    // Task create (tool result)
    const createMatch = line.match(TASK_CREATE_RE);
    if (createMatch) {
      this.callback({
        type: 'task-create',
        taskNumber: parseInt(createMatch[1], 10),
        description: createMatch[2].trim(),
      });
      return;
    }

    // Task update (tool result)
    const updateMatch = line.match(TASK_UPDATE_RE);
    if (updateMatch) {
      this.callback({
        type: 'task-update',
        taskNumber: parseInt(updateMatch[1], 10),
        status: 'in_progress',
      });
      return;
    }
  }

  // Batch consecutive task entries into a single task-list event
  private taskEntryCounter = 0;
  private pendingTaskList: { taskNumber: number; description: string; status: TaskStatus }[] = [];
  private taskListTimer: ReturnType<typeof setTimeout> | null = null;

  private emitTaskListEntry(taskNumber: number, status: TaskStatus, description: string): void {
    this.pendingTaskList.push({ taskNumber, status, description });

    if (this.taskListTimer) clearTimeout(this.taskListTimer);
    this.taskListTimer = setTimeout(() => {
      if (this.pendingTaskList.length > 0) {
        this.callback({ type: 'task-list', tasks: [...this.pendingTaskList] });
        this.pendingTaskList = [];
      }
      this.taskListTimer = null;
    }, 100);
  }
}

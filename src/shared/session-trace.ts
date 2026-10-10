export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export interface TaskEntry { taskNumber: number; description: string; status: TaskStatus }
export interface PlanEntry { title: string; status: 'active' | 'completed' }
export interface SubagentEntry { subagentId: string; description: string; status: 'active' | 'completed' }
export interface SessionTrace {
  mode: 'normal' | 'plan';
  plans: PlanEntry[];
  tasks: TaskEntry[];
  subagents: SubagentEntry[];
}
export interface SessionTraceSnapshot { revision: number; trace: SessionTrace }
export const EMPTY_TRACE: SessionTrace = { mode: 'normal', plans: [], tasks: [], subagents: [] };
export type SessionTraceEvent = (
  | { type: 'subagent:spawn'; sessionId: string; subagentId: string; description: string }
  | { type: 'subagent:complete'; sessionId: string; subagentId: string }
  | { type: 'plan:enter'; sessionId: string; planTitle: string }
  | { type: 'plan:exit'; sessionId: string }
  | { type: 'task:create'; sessionId: string; taskNumber: number; description: string }
  | { type: 'task:update'; sessionId: string; taskNumber: number; status: TaskStatus }
  | { type: 'task:list'; sessionId: string; tasks: TaskEntry[] }
) & { revision?: number; trace?: SessionTrace };

export function isTraceChannel(channel: string): boolean {
  return ['subagent:spawn', 'subagent:complete', 'plan:enter', 'plan:exit',
    'task:create', 'task:update', 'task:list'].includes(channel);
}

export function isTraceEvent(value: unknown): value is SessionTraceEvent {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (typeof e.sessionId !== 'string') return false;
  const status = (s: unknown) => s === 'pending' || s === 'in_progress' || s === 'completed';
  switch (e.type) {
    case 'subagent:spawn': return typeof e.subagentId === 'string' && typeof e.description === 'string';
    case 'subagent:complete': return typeof e.subagentId === 'string';
    case 'plan:enter': return typeof e.planTitle === 'string';
    case 'plan:exit': return true;
    case 'task:create': return typeof e.taskNumber === 'number' && typeof e.description === 'string';
    case 'task:update': return typeof e.taskNumber === 'number' && status(e.status);
    case 'task:list': return Array.isArray(e.tasks) && e.tasks.every(t =>
      t && typeof t.taskNumber === 'number' && typeof t.description === 'string' && status(t.status));
    default: return false;
  }
}

export function reduceTrace(trace: SessionTrace, event: SessionTraceEvent): SessionTrace {
  switch (event.type) {
    case 'subagent:spawn':
      return trace.subagents.some(sa => sa.subagentId === event.subagentId) ? trace :
        { ...trace, subagents: [...trace.subagents, { subagentId: event.subagentId, description: event.description, status: 'active' }] };
    case 'subagent:complete':
      return { ...trace, subagents: trace.subagents.map(sa =>
        sa.subagentId === event.subagentId ? { ...sa, status: 'completed' } : sa) };
    case 'plan:enter':
      return { ...trace, mode: 'plan', plans: [
        ...trace.plans.map(p => p.status === 'active' ? { ...p, status: 'completed' as const } : p),
        { title: event.planTitle, status: 'active' },
      ] };
    case 'plan:exit':
      return { ...trace, mode: 'normal', plans: trace.plans.map(p =>
        p.status === 'active' ? { ...p, status: 'completed' } : p) };
    case 'task:create':
      return trace.tasks.some(task => task.taskNumber === event.taskNumber) ? trace :
        { ...trace, tasks: [...trace.tasks, { taskNumber: event.taskNumber, description: event.description, status: 'pending' }] };
    case 'task:update':
      return { ...trace, tasks: trace.tasks.map(task =>
        task.taskNumber === event.taskNumber ? { ...task, status: event.status } : task) };
    case 'task:list':
      return { ...trace, tasks: event.tasks.map(task => ({ ...task })) };
  }
}

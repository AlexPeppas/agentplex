import { type NodeProps } from '@xyflow/react';
import { ClipboardList, Circle, Check, Users } from 'lucide-react';
import type { SessionInfo, SessionTrace, SessionStatus } from '../relay/types';
import { EMPTY_TRACE } from '../relay/types';
import { CliIcon } from './CliIcon';

export type SessionNodeData = {
  session: SessionInfo;
  displayName: string;
  trace: SessionTrace;
  selected: boolean;
  onClick: () => void;
  [key: string]: unknown;
};

const STATUS_VAR: Record<SessionStatus, string> = {
  running: 'var(--success)',
  idle: 'var(--text-muted)',
  'waiting-for-input': 'var(--warning)',
  killed: 'var(--error)',
};

/** Pulsing status dot — mirrors desktop StatusIndicator. */
function StatusIndicator({ status }: { status: SessionStatus }) {
  const pulse = status === 'running' || status === 'waiting-for-input';
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${pulse ? 'animate-[pulse-dot_1.5s_ease-in-out_infinite]' : ''}`}
      style={{ backgroundColor: STATUS_VAR[status] }}
    />
  );
}

export function SessionNodeComp({ data }: NodeProps) {
  const { session, displayName, selected, onClick } = data as SessionNodeData;
  const trace = (data as SessionNodeData).trace ?? EMPTY_TRACE;
  const isKilled = session.status === 'killed';
  const isWaiting = session.status === 'waiting-for-input';

  // Mirror desktop: keep all non-completed tasks + the last 2 completed ones.
  const completed = trace.tasks.filter(t => t.status === 'completed');
  const keep = new Set(completed.slice(-2).map(t => t.taskNumber));
  const visibleTasks = trace.tasks.filter(t => t.status !== 'completed' || keep.has(t.taskNumber));
  const activeSubagents = trace.subagents.filter(sa => sa.status === 'active').length;

  return (
    <div
      onClick={onClick}
      className={`group relative py-2.5 px-3.5 bg-elevated border-2 rounded-[10px] min-w-[190px] max-w-[230px] cursor-pointer select-none
        transition-[border-color,box-shadow] duration-150 hover:border-border-strong
        ${selected ? 'border-accent shadow-[0_0_12px_var(--accent-subtle-strong)]' : 'border-border'}
        ${isKilled ? 'opacity-60' : ''}`}
    >
      {/* CLI badge (top-left) */}
      <span className="absolute -top-2 -left-2 w-5 h-5 flex items-center justify-center bg-elevated border border-border rounded-full z-10 pointer-events-none">
        <CliIcon cli={session.cli} size={12} />
      </span>

      {/* Waiting badge (top-right) */}
      {isWaiting && (
        <span className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center bg-warning-bg text-surface text-xs font-bold rounded-full z-10 pointer-events-none animate-[attention-pulse_1.5s_ease-in-out_infinite]">?</span>
      )}

      {/* Title row */}
      <div className="flex items-center gap-2">
        <StatusIndicator status={session.status} />
        <span className="flex-1 text-[13px] font-medium text-fg whitespace-nowrap overflow-hidden text-ellipsis">{displayName}</span>
        {activeSubagents > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-accent shrink-0" title={`${activeSubagents} active sub-agent(s)`}>
            <Users size={11} />{activeSubagents}
          </span>
        )}
      </div>

      {/* Plan mode badge */}
      {trace.mode === 'plan' && (
        <div className="flex items-center gap-1.5 mt-2 py-1 px-2 bg-accent-subtle rounded-md overflow-hidden">
          <ClipboardList size={12} className="shrink-0 text-accent" />
          <span className="text-[11px] font-semibold text-accent whitespace-nowrap overflow-hidden text-ellipsis">Plan</span>
        </div>
      )}

      {/* Plan entries */}
      {trace.plans.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {trace.plans.map((plan, i) => (
            <div key={i} className="flex items-center gap-[5px] py-px">
              <span className={`shrink-0 w-3.5 flex justify-center ${plan.status === 'active' ? 'text-accent' : 'text-success'}`}>
                {plan.status === 'active' ? <Circle size={11} /> : <Check size={11} />}
              </span>
              <span className={`text-[11px] whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px] ${plan.status === 'active' ? 'text-fg' : 'text-fg-muted line-through'}`}>{plan.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* Task checklist */}
      {trace.tasks.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {visibleTasks.slice(0, 4).map(task => {
            const done = task.status === 'completed';
            const inProgress = task.status === 'in_progress';
            return (
              <div key={task.taskNumber} className="flex items-center gap-[5px] py-px">
                <span className={`shrink-0 w-3.5 flex justify-center ${done ? 'text-success' : inProgress ? 'text-accent' : 'text-fg-muted'}`}>
                  {done ? <Check size={11} /> : <Circle size={11} className={inProgress ? 'fill-current' : ''} />}
                </span>
                <span className={`text-[11px] whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px] ${done ? 'text-fg-muted line-through' : 'text-fg'}`}>
                  {task.taskNumber}. {task.description}
                </span>
              </div>
            );
          })}
          {visibleTasks.length > 4 && (
            <div className="text-[10px] text-fg-muted pl-[18px]">+{visibleTasks.length - 4} more</div>
          )}
        </div>
      )}

      {/* Footer: cwd */}
      <div className="flex items-center gap-1 mt-1 text-[10px] text-fg-muted">
        <span className="truncate font-mono">{session.cwd.replace(/\\/g, '/').split('/').pop() ?? ''}</span>
      </div>
    </div>
  );
}

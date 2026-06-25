import { type NodeProps } from '@xyflow/react';
import type { SessionInfo, SessionTrace } from '../relay/types';
import { EMPTY_TRACE } from '../relay/types';

export type SessionNodeData = {
  session: SessionInfo;
  displayName: string;
  trace: SessionTrace;
  onClick: () => void;
  [key: string]: unknown;
};

const STATUS_DOT: Record<string, string> = {
  running:             'bg-emerald-400',
  idle:                'bg-[#4a4038]',
  'waiting-for-input': 'bg-amber-400',
  killed:              'bg-red-500',
};

function CircleIcon({ className, filled }: { className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="5" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 8.5l3.5 3.5L13 4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SessionNodeComp({ data }: NodeProps) {
  const { session, displayName, onClick } = data as SessionNodeData;
  const trace = (data as SessionNodeData).trace ?? EMPTY_TRACE;
  const isWaiting = session.status === 'waiting-for-input';
  const dir = session.cwd.replace(/\\/g, '/').split('/').pop() ?? '';

  // Mirror desktop: keep all non-completed tasks + the last 2 completed ones.
  const completed = trace.tasks.filter(t => t.status === 'completed');
  const keep = new Set(completed.slice(-2).map(t => t.taskNumber));
  const visibleTasks = trace.tasks.filter(t => t.status !== 'completed' || keep.has(t.taskNumber));
  const activeSubagents = trace.subagents.filter(sa => sa.status === 'active').length;

  return (
    <div
      onClick={onClick}
      className="relative cursor-pointer select-none"
      style={{ width: 210 }}
    >
      {isWaiting && (
        <div className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-amber-400 flex items-center justify-center z-10">
          <span className="text-[10px] font-bold text-[#1a1814]">?</span>
        </div>
      )}

      <div
        className={`rounded-lg px-3 py-2.5 border transition-all duration-100
          ${isWaiting
            ? 'bg-[#2a2418] border-amber-900/50'
            : 'bg-[#232118] border-[#312d24] hover:border-[#4a4038]'
          }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 flex-shrink-0" fill="none">
            <path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4 3.4 12.6"
              stroke="#c4784a" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="text-sm font-medium text-[#ddd4c4] truncate">{displayName}</span>
          {activeSubagents > 0 && (
            <span className="ml-auto flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-[#c4874a]/20 text-[#c4874a]">
              {activeSubagents} agent{activeSubagents > 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1.5 ml-5 min-w-0">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[session.status] ?? 'bg-[#4a4038]'}`} />
          <span className="text-[11px] text-[#6a6050]">
            {session.status === 'waiting-for-input' ? 'waiting' : session.status}
          </span>
          {dir && (
            <>
              <span className="text-[#3a3028] text-[11px]">·</span>
              <span className="text-[11px] text-[#4a4038] truncate font-mono">{dir}</span>
            </>
          )}
        </div>

        {/* Plan mode badge */}
        {trace.mode === 'plan' && (
          <div className="flex items-center gap-1.5 mt-2 py-1 px-2 bg-[#c4874a]/15 rounded-md">
            <svg viewBox="0 0 16 16" className="w-3 h-3 flex-shrink-0 text-[#c4874a]" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="2" width="10" height="12" rx="1" /><path d="M6 6h4M6 9h4" strokeLinecap="round" />
            </svg>
            <span className="text-[11px] font-semibold text-[#c4874a]">Plan</span>
          </div>
        )}

        {/* Plan entries */}
        {trace.plans.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-0.5">
            {trace.plans.map((plan, i) => (
              <div key={i} className="flex items-center gap-1.5 py-px">
                <span className={`w-3 h-3 flex-shrink-0 ${plan.status === 'active' ? 'text-[#c4874a]' : 'text-emerald-500'}`}>
                  {plan.status === 'active' ? <CircleIcon className="w-3 h-3" /> : <CheckIcon className="w-3 h-3" />}
                </span>
                <span className={`text-[11px] truncate ${plan.status === 'active' ? 'text-[#ddd4c4]' : 'text-[#6a6050] line-through'}`}>{plan.title}</span>
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
                <div key={task.taskNumber} className="flex items-center gap-1.5 py-px">
                  <span className={`w-3 h-3 flex-shrink-0 ${done ? 'text-emerald-500' : inProgress ? 'text-[#c4874a]' : 'text-[#5a5040]'}`}>
                    {done ? <CheckIcon className="w-3 h-3" /> : <CircleIcon className="w-3 h-3" filled={inProgress} />}
                  </span>
                  <span className={`text-[11px] truncate ${done ? 'text-[#6a6050] line-through' : 'text-[#ddd4c4]'}`}>
                    {task.taskNumber}. {task.description}
                  </span>
                </div>
              );
            })}
            {visibleTasks.length > 4 && (
              <div className="text-[10px] text-[#5a5040] pl-[18px]">+{visibleTasks.length - 4} more</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

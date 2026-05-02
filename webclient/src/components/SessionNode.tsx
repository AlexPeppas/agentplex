import { type NodeProps } from '@xyflow/react';
import type { SessionInfo } from '../relay/types';

export type SessionNodeData = {
  session: SessionInfo;
  displayName: string;
  onClick: () => void;
  [key: string]: unknown;
};

const STATUS_DOT: Record<string, string> = {
  running:             'bg-emerald-400',
  idle:                'bg-[#4a4038]',
  'waiting-for-input': 'bg-amber-400',
  killed:              'bg-red-500',
};

export function SessionNodeComp({ data }: NodeProps) {
  const { session, displayName, onClick } = data as SessionNodeData;
  const isWaiting = session.status === 'waiting-for-input';
  const dir = session.cwd.replace(/\\/g, '/').split('/').pop() ?? '';

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
      </div>
    </div>
  );
}

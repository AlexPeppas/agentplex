import { type NodeProps } from '@xyflow/react';
import type { MachineStatus } from '../relay/types';

export type MachineGroupData = {
  label: string;
  machineId: string;
  status: MachineStatus;
  sessionCount: number;
  onAddSession: () => void;
  [key: string]: unknown;
};

function statusInfo(status: MachineStatus): { dot: string; label: string } {
  if (status.error) return { dot: 'bg-red-500', label: 'error' };
  if (status.relayState === 'connected' && status.online) return { dot: 'bg-emerald-400', label: 'live' };
  if (status.relayState === 'connected' && !status.online) return { dot: 'bg-[#4a4038]', label: 'offline' };
  if (status.relayState === 'connecting') return { dot: 'bg-amber-400 animate-pulse', label: 'connecting' };
  return { dot: 'bg-[#4a4038]', label: 'disconnected' };
}

/** Container node representing one paired machine; sessions render inside it. */
export function MachineGroupNode({ data }: NodeProps) {
  const { label, status, sessionCount, onAddSession } = data as MachineGroupData;
  const info = statusInfo(status);
  const online = status.relayState === 'connected' && status.online;

  return (
    <div className="w-full h-full rounded-xl border border-[#2a2420] bg-[#15130f]/60">
      {/* Header bar — drag handle for the whole machine cluster */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[#232018] rounded-t-xl bg-[#1c1a15]">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${info.dot}`} title={info.label} />
        <span className="text-sm font-semibold text-[#ddd4c4] truncate">{label}</span>
        <span className="text-[10px] uppercase tracking-wider text-[#5a5040]">{info.label}</span>
        <span className="text-[11px] text-[#4a4038]">·</span>
        <span className="text-[11px] text-[#6a6050]">{sessionCount} session{sessionCount === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onAddSession(); }}
          disabled={!online}
          className="nodrag text-[11px] px-2 py-0.5 rounded text-[#c4874a] border border-[#c4874a]/30
            hover:bg-[#c4874a]/15 transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="New Claude session on this machine"
        >
          + New
        </button>
      </div>
    </div>
  );
}

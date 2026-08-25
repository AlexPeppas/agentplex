import { type NodeProps } from '@xyflow/react';
import { Plus, Monitor } from 'lucide-react';
import type { MachineStatus } from '../relay/types';

export type MachineGroupData = {
  label: string;
  machineId: string;
  status: MachineStatus;
  sessionCount: number;
  onAddSession: () => void;
  [key: string]: unknown;
};

function statusInfo(status: MachineStatus): { color: string; label: string } {
  if (status.error) return { color: 'var(--error)', label: 'error' };
  if (status.relayState === 'connected' && status.online) return { color: 'var(--success)', label: 'live' };
  if (status.relayState === 'connected' && !status.online) return { color: 'var(--text-muted)', label: 'offline' };
  if (status.relayState === 'connecting') return { color: 'var(--warning)', label: 'connecting' };
  return { color: 'var(--text-muted)', label: 'disconnected' };
}

/** Container node representing one paired machine; sessions render inside it. */
export function MachineGroupNode({ data }: NodeProps) {
  const { label, status, sessionCount, onAddSession } = data as MachineGroupData;
  const info = statusInfo(status);
  const online = status.relayState === 'connected' && status.online;

  return (
    <div className="w-full h-full rounded-xl border-2 border-border bg-inset/60">
      {/* Header bar */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-border rounded-t-xl bg-elevated">
        <Monitor size={13} className="text-fg-muted shrink-0" />
        <span className="text-[13px] font-semibold text-fg truncate">{label}</span>
        <span className="flex items-center gap-1 shrink-0">
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: info.color }} title={info.label} />
          <span className="text-[10px] uppercase tracking-wider text-fg-muted">{info.label}</span>
        </span>
        <span className="text-[11px] text-fg-muted">·</span>
        <span className="text-[11px] text-fg-muted">{sessionCount} session{sessionCount === 1 ? '' : 's'}</span>
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onAddSession(); }}
          disabled={!online}
          className="nodrag flex items-center gap-1 text-[11px] px-2 py-0.5 rounded text-accent border border-accent-border
            hover:bg-accent-subtle transition-colors disabled:opacity-30 disabled:pointer-events-none"
          title="New Claude session on this machine"
        >
          <Plus size={11} /> New
        </button>
      </div>
    </div>
  );
}

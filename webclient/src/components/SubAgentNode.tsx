import { Handle, Position, type NodeProps } from '@xyflow/react';

export type SubAgentNodeData = {
  label: string;
  status: 'active' | 'completed';
  [key: string]: unknown;
};

/** Sub-agent node — mirrors the desktop SubAgentNode (border-l accent card). */
export function SubAgentNodeComp({ data }: NodeProps) {
  const { label, status } = data as SubAgentNodeData;
  const active = status === 'active';

  return (
    <div
      className={`py-1.5 px-2.5 bg-elevated border-2 border-border border-l-4 border-l-accent rounded-lg min-w-[120px] max-w-[180px] select-none
        transition-[border-color,box-shadow,opacity] duration-200
        ${active ? 'shadow-[0_0_10px_var(--accent-subtle-strong)]' : 'opacity-70'}`}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
      <div className="text-[11px] font-medium text-fg whitespace-nowrap overflow-hidden text-ellipsis">{label}</div>
    </div>
  );
}

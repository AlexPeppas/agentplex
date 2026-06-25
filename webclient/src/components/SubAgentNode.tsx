import { Handle, Position, type NodeProps } from '@xyflow/react';

export type SubAgentNodeData = {
  label: string;
  status: 'active' | 'completed';
  [key: string]: unknown;
};

export function SubAgentNodeComp({ data }: NodeProps) {
  const { label, status } = data as SubAgentNodeData;
  const active = status === 'active';

  return (
    <div
      className={`py-1.5 px-2.5 rounded-lg border-2 border-l-4 select-none transition-all duration-200
        bg-[#232118] min-w-[120px] max-w-[170px]
        ${active
          ? 'border-[#312d24] border-l-[#c4874a] shadow-[0_0_10px_rgba(196,135,74,0.25)]'
          : 'border-[#312d24] border-l-emerald-500 opacity-70'
        }`}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${active ? 'bg-[#c4874a]' : 'bg-emerald-500'}`} />
        <span className="text-[11px] font-medium text-[#ddd4c4] truncate">{label}</span>
      </div>
    </div>
  );
}

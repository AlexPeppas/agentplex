import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { X } from 'lucide-react';
import { useAppStore } from '../store';

export type SubAgentNodeData = {
  label: string;
  status: 'active' | 'completed' | 'faded';
  [key: string]: unknown;
};

type SubAgentNodeType = Node<SubAgentNodeData, 'subagentNode'>;

export function SubAgentNode({ id, data }: NodeProps<SubAgentNodeType>) {
  const dismissSubagent = useAppStore((s) => s.dismissSubagent);

  const statusClasses =
    data.status === 'active'
      ? 'border-l-accent'
      : data.status === 'completed'
        ? 'border-l-accent shadow-none'
        : 'border-l-accent opacity-0 transition-opacity duration-[3s] ease-out';

  return (
    <div className={`group py-2 px-3 bg-elevated border border-border border-l-2 rounded-lg min-w-[120px] max-w-[180px] select-none transition-[border-color,opacity] duration-200 ${statusClasses}`}>
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-1.5">
        <div className="flex-1 text-[11px] font-medium text-fg whitespace-nowrap overflow-hidden text-ellipsis">{data.label}</div>
        <button
          className="shrink-0 w-4 h-4 flex items-center justify-center bg-transparent border border-border-strong rounded-[3px] text-fg-muted cursor-pointer opacity-0 transition-[opacity,background,color] duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-error-subtle hover:text-error"
          aria-label="Dismiss sub-agent"
          onClick={(e) => {
            e.stopPropagation();
            dismissSubagent(id);
          }}
        >
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

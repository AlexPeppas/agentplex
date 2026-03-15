import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { useAppStore } from '../store';

export type SubAgentNodeData = {
  label: string;
  status: 'active' | 'completed' | 'faded';
  [key: string]: unknown;
};

type SubAgentNodeType = Node<SubAgentNodeData, 'subagentNode'>;

export function SubAgentNode({ id, data }: NodeProps<SubAgentNodeType>) {
  const dismissSubagent = useAppStore((s) => s.dismissSubagent);

  const statusClass =
    data.status === 'active'
      ? 'subagent-node--active'
      : data.status === 'completed'
        ? 'subagent-node--completed'
        : 'subagent-node--faded';

  return (
    <div className={`subagent-node ${statusClass}`}>
      <Handle type="target" position={Position.Top} />
      <div className="subagent-node__header">
        <div className="subagent-node__label">{data.label}</div>
        <button
          className="subagent-node__dismiss"
          onClick={(e) => {
            e.stopPropagation();
            dismissSubagent(id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

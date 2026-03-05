import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export type SubAgentNodeData = {
  label: string;
  status: 'active' | 'completed' | 'faded';
  [key: string]: unknown;
};

type SubAgentNodeType = Node<SubAgentNodeData, 'subagentNode'>;

export function SubAgentNode({ data }: NodeProps<SubAgentNodeType>) {
  const statusClass =
    data.status === 'active'
      ? 'subagent-node--active'
      : data.status === 'completed'
        ? 'subagent-node--completed'
        : 'subagent-node--faded';

  return (
    <div className={`subagent-node ${statusClass}`}>
      <Handle type="target" position={Position.Top} />
      <div className="subagent-node__label">{data.label}</div>
    </div>
  );
}

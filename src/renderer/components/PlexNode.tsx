import { Bot } from 'lucide-react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { usePlexStore } from '../plex-store';

export function PlexNode({ data }: NodeProps) {
  const inspect = () => {
    const store = usePlexStore.getState();
    if (typeof data.agentId === 'string' && typeof data.conversationId === 'string') {
      store.inspectWorker(data.conversationId, data.agentId);
    } else store.setOpen(true);
  };
  return (
    <div className="rounded-xl border-2 border-accent bg-surface text-fg p-3 w-[210px] shadow-lg">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button className="nodrag flex items-center gap-2 text-left w-full" onClick={inspect}>
        <Bot size={20} className="text-accent shrink-0" />
        <span className="min-w-0">
          <strong className="block truncate text-sm">{String(data.label)}</strong>
          <span className="block text-[10px] text-fg-muted">{String(data.detail)}</span>
        </span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}

export function PlexSquadNode({ data }: NodeProps) {
  return <div className="w-full h-full rounded-xl border border-accent/40 bg-accent/5 p-2 text-xs text-fg-muted">
    {String(data.label)} · active squad
  </div>;
}

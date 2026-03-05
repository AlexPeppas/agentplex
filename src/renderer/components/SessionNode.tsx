import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore, type SessionNodeData } from '../store';
import { SessionStatus } from '../../shared/ipc-channels';

export const SessionNode = memo(function SessionNode({ data, id }: NodeProps) {
  const nodeData = data as SessionNodeData;
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const isSelected = selectedSessionId === nodeData.sessionId;
  const isKilled = nodeData.status === SessionStatus.Killed;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectSession(nodeData.sessionId);
  };

  const handleKill = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isKilled) {
      window.agentField.killSession(nodeData.sessionId);
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    removeSession(nodeData.sessionId);
  };

  return (
    <div
      className={`session-node ${isSelected ? 'session-node--selected' : ''} ${isKilled ? 'session-node--killed' : ''}`}
      onClick={handleClick}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="session-node__header">
        <StatusIndicator status={nodeData.status} />
        <span className="session-node__title">{nodeData.label}</span>
        {isKilled ? (
          <button
            className="session-node__remove"
            onClick={handleRemove}
            title="Remove from field"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        ) : (
          <button
            className="session-node__kill"
            onClick={handleKill}
            title="Kill session"
          >
            ×
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
});

import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore, type SessionNodeData } from '../store';
import { SessionStatus } from '../../shared/ipc-channels';

export const SessionNode = memo(function SessionNode({ data, id }: NodeProps) {
  const nodeData = data as SessionNodeData;
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  // Subscribe directly to store status so React Flow's memo diffing can't block re-renders
  const status = useAppStore((s) => s.sessions[nodeData.sessionId]?.status ?? nodeData.status);
  const isSelected = selectedSessionId === nodeData.sessionId;
  const isKilled = status === SessionStatus.Killed;
  const isWaiting = status === SessionStatus.WaitingForInput;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectSession(nodeData.sessionId);
  };

  const handleKill = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isKilled) {
      window.agentPlex.killSession(nodeData.sessionId);
    }
  };

  const handleRemove = (e: React.MouseEvent) => {
    e.stopPropagation();
    removeSession(nodeData.sessionId);
  };

  const handleSend = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSendDialog(nodeData.sessionId);
  };

  return (
    <div
      className={`session-node ${isSelected ? 'session-node--selected' : ''} ${isKilled ? 'session-node--killed' : ''}`}
      onClick={handleClick}
    >
      {isWaiting && <span className="session-node__attention">?</span>}
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="session-node__header">
        <StatusIndicator status={status} />
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
          <>
            <button
              className="session-node__send"
              onClick={handleSend}
              title="Send message to session"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
            <button
              className="session-node__kill"
              onClick={handleKill}
              title="Kill session"
            >
              ×
            </button>
          </>
        )}
      </div>

      {nodeData.mode === 'plan' && (
        <div className="session-node__plan-badge">
          <span className="session-node__plan-badge-icon">{'\uD83D\uDCDD'}</span>
          <span className="session-node__plan-title">Plan</span>
        </div>
      )}

      {nodeData.plans.length > 0 && (
        <div className="session-node__plan-entries">
          {nodeData.plans.map((plan, i) => (
            <div key={i} className={`session-node__plan-entry session-node__plan-entry--${plan.status}`}>
              <span className="session-node__plan-entry-icon">
                {plan.status === 'active' ? '\u25C9' : '\u2713'}
              </span>
              <span className="session-node__plan-entry-title">{plan.title}</span>
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
});

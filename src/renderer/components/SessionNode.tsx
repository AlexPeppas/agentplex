import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore, type SessionNodeData } from '../store';
import { SessionStatus } from '../../shared/ipc-channels';

export const SessionNode = memo(function SessionNode({ data, id }: NodeProps) {
  const nodeData = data as SessionNodeData;
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);
  const renameSession = useAppStore((s) => s.renameSession);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const status = useAppStore((s) => s.sessions[nodeData.sessionId]?.status ?? nodeData.status);
  const isSelected = selectedSessionId === nodeData.sessionId;
  const isKilled = status === SessionStatus.Killed;
  const isWaiting = status === SessionStatus.WaitingForInput;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Close confirm popover on outside click
  useEffect(() => {
    if (!confirmingDelete) return;
    const handler = (e: MouseEvent) => {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirmingDelete(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [confirmingDelete]);

  useEffect(() => {
    if (!projectMenu) return;
    const handler = (e: MouseEvent) => {
      if (projectMenuRef.current && !projectMenuRef.current.contains(e.target as Node)) {
        setProjectMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [projectMenu]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== nodeData.label) {
      renameSession(nodeData.sessionId, trimmed);
    }
    setEditing(false);
  }, [draft, nodeData.label, nodeData.sessionId, renameSession]);

  const handleTitleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(nodeData.label);
    setEditing(true);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    selectSession(nodeData.sessionId);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmingDelete(true);
  };

  const handleConfirmDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmingDelete(false);
    if (!isKilled) {
      window.agentPlex.killSession(nodeData.sessionId);
    }
    removeSession(nodeData.sessionId);
  };

  const handleCancelDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmingDelete(false);
  };

  const handleSend = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSendDialog(nodeData.sessionId);
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setProjectMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleOpenProjectConfig = useCallback(async () => {
    setProjectMenu(null);
    const cwd = await window.agentPlex.getSessionCwd(nodeData.sessionId);
    if (cwd) {
      window.agentPlex.openProjectConfig(cwd);
    }
  }, [nodeData.sessionId]);

  const trashIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );

  return (
    <div
      className={`session-node ${isSelected ? 'session-node--selected' : ''} ${isKilled ? 'session-node--killed' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {isWaiting && <span className="session-node__attention">?</span>}
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="session-node__header">
        <StatusIndicator status={status} />
        {editing ? (
          <input
            ref={inputRef}
            className="session-node__title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="session-node__title" onDoubleClick={handleTitleDoubleClick}>
            {nodeData.label}
          </span>
        )}
        {!isKilled && (
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
        )}
        <button
          className="session-node__remove"
          onClick={handleDeleteClick}
          title="Delete session"
        >
          {trashIcon}
        </button>
      </div>

      {confirmingDelete && (
        <div className="session-node__confirm" ref={confirmRef} onClick={(e) => e.stopPropagation()}>
          <span className="session-node__confirm-text">Delete this session?</span>
          <div className="session-node__confirm-actions">
            <button className="session-node__confirm-delete" onClick={handleConfirmDelete}>Delete</button>
            <button className="session-node__confirm-cancel" onClick={handleCancelDelete}>Cancel</button>
          </div>
        </div>
      )}

      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="session-node__context-menu"
          style={{ position: 'fixed', left: projectMenu.x, top: projectMenu.y, zIndex: 1000 }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="session-node__context-menu-item"
            onClick={handleOpenProjectConfig}
          >
            Open Project Settings
          </button>
        </div>
      )}

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

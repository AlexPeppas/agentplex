import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Trash2, Send, ClipboardList, Circle, Check } from 'lucide-react';
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


  return (
    <div
      className={`group relative py-2.5 px-3.5 bg-elevated border-2 border-border rounded-[10px] min-w-[160px] cursor-pointer transition-[border-color,box-shadow] duration-150 select-none hover:border-border-strong ${isSelected ? 'border-accent shadow-[0_0_12px_var(--accent-subtle-strong)]' : ''} ${isKilled ? 'opacity-60' : ''}`}
      onClick={handleClick}
    >
      {isWaiting && <span className="absolute -top-2 -right-2 w-5 h-5 flex items-center justify-center bg-warning-bg text-surface text-xs font-bold rounded-full z-10 pointer-events-none animate-[attention-pulse_1.5s_ease-in-out_infinite]">?</span>}
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="flex items-center gap-2">
        <StatusIndicator status={status} />
        {editing ? (
          <input
            ref={inputRef}
            className="flex-1 text-[13px] font-medium text-fg bg-transparent border-none border-b border-b-accent outline-none w-full p-0 font-[inherit]"
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
          <span className="flex-1 text-[13px] font-medium whitespace-nowrap overflow-hidden text-ellipsis" onDoubleClick={handleTitleDoubleClick}>
            {nodeData.label}
          </span>
        )}
        {!isKilled && (
          <button
            className="w-5 h-5 flex items-center justify-center bg-transparent border border-border-strong rounded-[4px] text-accent cursor-pointer opacity-0 transition-[opacity,background] duration-150 group-hover:opacity-100 hover:bg-accent-subtle"
            onClick={handleSend}
            title="Send message to session"
          >
            <Send size={14} />
          </button>
        )}
        <button
          className="w-5 h-5 flex items-center justify-center bg-transparent border border-border-strong rounded-[4px] text-fg-muted cursor-pointer opacity-0 transition-[opacity,background,color] duration-150 group-hover:opacity-100 hover:bg-error-subtle hover:text-error"
          onClick={handleDeleteClick}
          title="Delete session"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {confirmingDelete && (
        <div className="mt-2 p-2 bg-elevated border border-border-strong rounded-lg shadow-[0_4px_12px_var(--shadow)]" ref={confirmRef} onClick={(e) => e.stopPropagation()}>
          <span className="block text-xs font-medium text-fg mb-2">Delete this session?</span>
          <div className="flex gap-1.5">
            <button className="flex-1 py-1 bg-error text-surface border-none rounded-[5px] text-xs font-semibold cursor-pointer transition-opacity hover:opacity-85" onClick={handleConfirmDelete}>Delete</button>
            <button className="flex-1 py-1 bg-border text-fg border-none rounded-[5px] text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong" onClick={handleCancelDelete}>Cancel</button>
          </div>
        </div>
      )}

      {nodeData.mode === 'plan' && (
        <div className="flex items-center gap-1.5 mt-2 py-1 px-2 bg-accent-subtle rounded-md overflow-hidden">
          <ClipboardList size={12} className="shrink-0" />
          <span className="text-[11px] font-semibold text-accent whitespace-nowrap overflow-hidden text-ellipsis">Plan</span>
        </div>
      )}

      {nodeData.plans.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {nodeData.plans.map((plan, i) => (
            <div key={i} className="flex items-center gap-[5px] py-px">
              <span className={`shrink-0 w-3.5 flex justify-center ${plan.status === 'active' ? 'text-accent' : 'text-success'}`}>
                {plan.status === 'active' ? <Circle size={11} /> : <Check size={11} />}
              </span>
              <span className={`text-[11px] whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px] ${plan.status === 'active' ? 'text-fg' : 'text-fg-muted line-through'}`}>{plan.title}</span>
            </div>
          ))}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
});

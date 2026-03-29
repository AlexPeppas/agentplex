import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Send, ClipboardList, Circle, Check, Terminal } from 'lucide-react';
import { StatusIndicator } from './StatusIndicator';
import { useAppStore, type SessionNodeData } from '../store';
import { SessionStatus, type CliTool } from '../../shared/ipc-channels';
import claudeLogo from '../../../assets/claude-logo.svg';
import codexDark from '../../../assets/codex-dark.svg';
import codexLight from '../../../assets/codex-light.svg';
import copilotDark from '../../../assets/githubcopilot-dark.svg';
import copilotLight from '../../../assets/githubcopilot-light.svg';

const CLI_ICONS: Record<string, { dark: string; light: string }> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};

export function CliIcon({ cli, size = 14 }: { cli?: CliTool; size?: number }) {
  if (!cli) return null;
  const icons = CLI_ICONS[cli];
  if (!icons) return <Terminal size={size} className="shrink-0 text-fg-muted" />;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const src = theme === 'dark' ? icons.dark : icons.light;
  return <img src={src} alt="" style={{ width: size, height: size }} className="shrink-0" />;
}

export const SessionNode = memo(function SessionNode({ data, id }: NodeProps) {
  const nodeData = data as SessionNodeData;
  const selectSession = useAppStore((s) => s.selectSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);
  const renameSession = useAppStore((s) => s.renameSession);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const status = useAppStore((s) => s.sessions[nodeData.sessionId]?.status ?? nodeData.status);
  const cli = useAppStore((s) => s.sessions[nodeData.sessionId]?.cli);
  const isSelected = selectedSessionId === nodeData.sessionId;
  const isKilled = status === SessionStatus.Killed;
  const isWaiting = status === SessionStatus.WaitingForInput;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

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

  const handleSend = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSendDialog(nodeData.sessionId);
  };

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(nodeData.label);
    setEditing(true);
  };

  const editIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );

  return (
    <div
      className={`group relative py-2.5 px-3.5 bg-elevated border-2 border-border rounded-[10px] min-w-[160px] cursor-pointer transition-[border-color,box-shadow] duration-150 select-none hover:border-border-strong ${isSelected ? 'border-accent shadow-[0_0_12px_var(--accent-subtle-strong)]' : ''} ${isKilled ? 'opacity-60' : ''}`}
      onClick={handleClick}
    >
      {cli && (
        <span className="absolute -top-2 -left-2 w-5 h-5 flex items-center justify-center bg-elevated border border-border rounded-full z-10 pointer-events-none">
          <CliIcon cli={cli} size={12} />
        </span>
      )}
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
        {!editing && (
          <button
            className="session-node__edit"
            onClick={handleEditClick}
            title="Rename session"
          >
            {editIcon}
          </button>
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
      </div>

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

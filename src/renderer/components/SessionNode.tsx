import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Send, CopyPlus, ClipboardList, Circle, Check, Trash2, GitBranch } from 'lucide-react';
import { CliIcon } from './CliIcon';
import { StatusIndicator } from './StatusIndicator';
import { ContextMeter, SessionAge } from './SessionMetrics';
import { useAppStore, isSendTarget, type SessionNodeData } from '../store';
import { SessionStatus } from '../../shared/ipc-channels';
import { useViewportMenu } from '../hooks/useViewportMenu';

export const SessionNode = memo(function SessionNode({ data, id, parentId }: NodeProps) {
  const nodeData = data as SessionNodeData;
  const selectSession = useAppStore((s) => s.selectSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);
  const addSession = useAppStore((s) => s.addSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const deleteSession = useAppStore((s) => s.deleteSession);
  const createGroupWithMembers = useAppStore((s) => s.createGroupWithMembers);
  const addToGroup = useAppStore((s) => s.addToGroup);
  const removeFromGroup = useAppStore((s) => s.removeFromGroup);
  const isSelected = useAppStore((s) => s.openPanes.includes(nodeData.sessionId));
  const status = useAppStore((s) => s.sessions[nodeData.sessionId]?.status ?? nodeData.status);
  const cli = useAppStore((s) => s.sessions[nodeData.sessionId]?.cli);
  const session = useAppStore((s) => s.sessions[nodeData.sessionId]);
  const hasSendTarget = useAppStore((s) =>
    Object.values(s.sessions).some((target) => isSendTarget(target, nodeData.sessionId)));
  const canDuplicate = cli === 'claude' || cli === 'claude-resume';
  const [duplicating, setDuplicating] = useState(false);
  const isKilled = status === SessionStatus.Killed;
  const isWaiting = status === SessionStatus.WaitingForInput;
  const completedTasks = nodeData.tasks
    .filter((t) => t.status === 'completed')
    .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
  const keepCompleted = new Set(completedTasks.slice(-2).map((t) => t.taskNumber));
  const visibleTasks = nodeData.tasks.filter((t) => t.status !== 'completed' || keepCompleted.has(t.taskNumber));
  const allTasksCompleted = nodeData.tasks.length > 0 && nodeData.tasks.every((t) => t.status === 'completed');

  const viewportMoveCount = useAppStore((s) => s.viewportMoveCount);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [branchName, setBranchName] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [projectMenu, setProjectMenu] = useState<{ x: number; y: number } | null>(null);
  const [groupSubmenuOpen, setGroupSubmenuOpen] = useState(false);
  const [menuGroups, setMenuGroups] = useState<{ id: string; label: string; color: string }[]>([]);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const groupAnchorRef = useRef<HTMLDivElement>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  useViewportMenu(projectMenuRef, projectMenu);
  useViewportMenu(groupMenuRef, groupSubmenuOpen ? projectMenu : null, groupAnchorRef);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // Fetch git branch name on mount and periodically
  useEffect(() => {
    if (isKilled) return;
    let cancelled = false;
    const fetchBranch = () => {
      window.agentPlex.gitBranchInfo(nodeData.sessionId).then((info) => {
        if (!cancelled) setBranchName(info?.current ?? null);
      }).catch(() => {
        if (!cancelled) setBranchName(null);
      });
    };
    fetchBranch();
    const interval = setInterval(fetchBranch, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [nodeData.sessionId, isKilled]);


  // Dismiss on viewport pan/zoom (React Flow's onMove)
  useEffect(() => {
    if (projectMenu) setProjectMenu(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewportMoveCount]);

  // Dismiss context menu on any interaction outside it
  useEffect(() => {
    if (!projectMenu) return;
    const dismissIfOutside = (e: Event) => {
      if (projectMenuRef.current && projectMenuRef.current.contains(e.target as Node)) return;
      setProjectMenu(null);
    };
    const dismissAlways = () => setProjectMenu(null);
    const dismissOnOutsideWheel = (event: WheelEvent) => {
      if (!projectMenuRef.current?.contains(event.target as Node)) dismissAlways();
    };
    // Capture phase so we fire before React Flow swallows the event
    document.addEventListener('mousedown', dismissIfOutside, true);
    document.addEventListener('pointerdown', dismissIfOutside, true);
    document.addEventListener('wheel', dismissOnOutsideWheel, { capture: true, passive: true });
    document.addEventListener('keydown', dismissAlways, true);
    return () => {
      document.removeEventListener('mousedown', dismissIfOutside, true);
      document.removeEventListener('pointerdown', dismissIfOutside, true);
      document.removeEventListener('wheel', dismissOnOutsideWheel, { capture: true } as EventListenerOptions);
      document.removeEventListener('keydown', dismissAlways, true);
    };
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

  const handleSend = (e: React.MouseEvent) => {
    e.stopPropagation();
    openSendDialog(nodeData.sessionId);
  };

  const handleDuplicate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (duplicating) return;
    setDuplicating(true);
    try {
      addSession(await window.agentPlex.forkSession(nodeData.sessionId));
    } catch (error) {
      console.error('[duplicate] Failed to duplicate session:', error);
    } finally {
      setDuplicating(false);
    }
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const groups = useAppStore
      .getState()
      .nodes.filter((n) => n.type === 'groupNode')
      .map((n) => ({
        id: n.id,
        label: (n.data as { label?: string }).label ?? 'Group',
        color: (n.data as { color?: string }).color ?? '#7aa2f7',
      }));
    setMenuGroups(groups);
    setGroupSubmenuOpen(false);
    setProjectMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleNewGroup = useCallback(() => {
    setProjectMenu(null);
    createGroupWithMembers([id]);
  }, [createGroupWithMembers, id]);

  const handleAddToExistingGroup = useCallback((groupId: string) => {
    setProjectMenu(null);
    addToGroup(groupId, id, { reposition: true });
  }, [addToGroup, id]);

  const handleRemoveFromGroup = useCallback(() => {
    setProjectMenu(null);
    removeFromGroup(id);
  }, [removeFromGroup, id]);

  const handleOpenProjectConfig = useCallback(async () => {
    setProjectMenu(null);
    try {
      const cwd = await window.agentPlex.getSessionCwd(nodeData.sessionId);
      if (cwd) {
        await window.agentPlex.openProjectConfig(cwd);
      }
    } catch (error) {
      console.error('Failed to open project config for session', nodeData.sessionId, error);
    }
  }, [nodeData.sessionId]);

  const handleEditClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setDraft(nodeData.label);
    setEditing(true);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete session "${nodeData.label}"?`)) {
      deleteSession(nodeData.sessionId);
    }
  };

  const editIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );

  return (
    <div
      className={`session-node group relative cursor-pointer select-none ${isKilled ? 'opacity-60' : ''}`}
      data-selected={isSelected}
      data-waiting={isWaiting}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      <div className="flex items-center gap-1.5 mb-2 text-[10px] text-fg-muted">
        <CliIcon cli={cli} size={13} />
        <span className="capitalize truncate">{cli || 'Session'}</span>
        <span className={`ml-auto flex items-center gap-1.5 shrink-0 ${isWaiting ? 'text-warning' : ''}`}>
          <StatusIndicator status={status} />
          <span className="capitalize">{isWaiting ? 'Needs input' : status}</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
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
          <div className="session-node__actions absolute right-2 top-1.5 flex items-center gap-1 p-1 bg-elevated border border-border rounded-md opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {!isKilled && (
              <button
                className="w-5 h-5 flex items-center justify-center rounded text-fg-muted cursor-pointer hover:bg-accent-subtle hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                onClick={handleSend}
                disabled={!hasSendTarget}
                title={hasSendTarget
                  ? 'Send message to another session'
                  : 'No other active session to send to. Start another session to share context.'}
              >
                <Send size={14} />
              </button>
            )}
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-fg-muted cursor-pointer hover:bg-accent-subtle hover:text-fg disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted"
              onClick={handleDuplicate}
              disabled={!canDuplicate || duplicating}
              title={canDuplicate
                ? 'Duplicate Session'
                : 'Duplicate Session is available for Claude sessions.'}
            >
              <CopyPlus size={14} />
            </button>
            <button
              className="session-node__edit"
              onClick={handleEditClick}
              title="Rename session"
            >
              {editIcon}
            </button>
            <button
              className="w-5 h-5 flex items-center justify-center rounded text-fg-muted cursor-pointer hover:bg-error-subtle hover:text-error"
              onClick={handleDelete}
              title="Delete session"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
      {branchName && (
        <div className="flex items-center gap-1 mt-1 text-[10px] text-fg-muted">
          <GitBranch size={9} className="shrink-0" />
          <span className="truncate">{branchName}</span>
        </div>
      )}
      {session && (
        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border-soft">
          <ContextMeter usage={session.usage} supported={session.telemetrySupported} compact />
          <SessionAge
            startedAt={session.startedAt}
            lastActivityAt={session.lastActivityAt}
            compact
          />
        </div>
      )}

      {projectMenu && createPortal(
        <div
          ref={projectMenuRef}
          role="menu"
          aria-label="Session project actions"
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

          {parentId ? (
            <button
              className="session-node__context-menu-item"
              onClick={handleRemoveFromGroup}
            >
              Remove from group
            </button>
          ) : (
            <div
              ref={groupAnchorRef}
              className="session-node__submenu-anchor"
              onMouseEnter={() => setGroupSubmenuOpen(true)}
              onMouseLeave={() => setGroupSubmenuOpen(false)}
            >
              <button className="session-node__context-menu-item session-node__context-menu-item--submenu">
                <span>Add to group</span>
                <span className="session-node__submenu-caret">›</span>
              </button>
              {groupSubmenuOpen && (
                <div ref={groupMenuRef} role="menu" aria-label="Session groups" className="session-node__context-menu session-node__submenu">
                  <button
                    className="session-node__context-menu-item"
                    onClick={handleNewGroup}
                  >
                    + New group
                  </button>
                  {menuGroups.length > 0 && <div className="session-node__submenu-divider" />}
                  {menuGroups.map((g) => (
                    <button
                      key={g.id}
                      className="session-node__context-menu-item session-node__context-menu-item--group"
                      onClick={() => handleAddToExistingGroup(g.id)}
                    >
                      <span className="session-node__group-swatch" style={{ backgroundColor: g.color }} />
                      <span className="truncate">{g.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>,
        document.body,
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

      {nodeData.tasks.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {visibleTasks.slice(0, 4).map((task) => {
            const done = task.status === 'completed';
            const inProgress = task.status === 'in_progress';
            return (
              <div key={task.taskNumber} className="flex items-center gap-[5px] py-px">
                <span className={`shrink-0 w-3.5 flex justify-center ${done ? 'text-success' : inProgress ? 'text-accent' : 'text-fg-muted'}`}>
                  {done ? <Check size={11} /> : <Circle size={11} className={inProgress ? 'fill-current' : ''} />}
                </span>
                <span className={`text-[11px] whitespace-nowrap overflow-hidden text-ellipsis max-w-[180px] ${done ? 'text-fg-muted line-through' : 'text-fg'}`}>
                  {task.taskNumber}. {task.description}
                </span>
              </div>
            );
          })}
          {visibleTasks.length > 4 && (
            <div className="text-[10px] text-fg-muted pl-[18px]">+{visibleTasks.length - 4} more</div>
          )}
          {allTasksCompleted && (
            <div className="text-[10px] text-fg-muted pl-[18px]">Clearing in 5s…</div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
});

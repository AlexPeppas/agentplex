import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, Terminal, Pencil, Trash2, Send, FolderOpen, Star, Layers } from 'lucide-react';
import { useAppStore } from '../../store';
import { CLI_TOOLS, SessionStatus, type CliTool, type DetectedShell } from '../../../shared/ipc-channels';
import claudeLogo from '../../../../assets/claude-logo.svg';
import codexDark from '../../../../assets/codex-dark.svg';
import codexLight from '../../../../assets/codex-light.svg';
import copilotDark from '../../../../assets/githubcopilot-dark.svg';
import copilotLight from '../../../../assets/githubcopilot-light.svg';

const CLI_ICONS: Record<string, { dark: string; light: string }> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};


function CliIcon({ cli }: { cli: CliTool }) {
  const icons = CLI_ICONS[cli];
  if (!icons) return <Terminal size={13} className="shrink-0 text-fg-muted" />;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const src = theme === 'dark' ? icons.dark : icons.light;
  return <img src={src} alt="" className="w-3.5 h-3.5 shrink-0" />;
}

/** Convert a #rrggbb hex colour to an rgba() string with the given alpha. */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

interface DirEntry {
  cwd: string;
  dirName: string;
  sessions: { id: string; label: string; status: SessionStatus; cli: CliTool }[];
}

type ContextMenu =
  | { type: 'session'; x: number; y: number; sessionId: string }
  | { type: 'dir'; x: number; y: number; cwd: string };

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const openPanes = useAppStore((s) => s.openPanes);
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);
  const addSession = useAppStore((s) => s.addSession);
  const openLauncher = useAppStore((s) => s.openLauncher);
  const createGroupWithMembers = useAppStore((s) => s.createGroupWithMembers);
  const addToGroup = useAppStore((s) => s.addToGroup);
  const removeFromGroup = useAppStore((s) => s.removeFromGroup);
  const nodes = useAppStore((s) => s.nodes);

  // Map sessionId → its group's label/color, for the explorer colour cue.
  const sessionGroups = useMemo(() => {
    const groupById = new Map<string, { label: string; color: string }>();
    for (const n of nodes) {
      if (n.type === 'groupNode') {
        groupById.set(n.id, {
          label: (n.data as { label?: string }).label ?? 'Group',
          color: (n.data as { color?: string }).color ?? '#7aa2f7',
        });
      }
    }
    const map = new Map<string, { label: string; color: string }>();
    for (const n of nodes) {
      if (n.type === 'sessionNode' && n.parentId) {
        const g = groupById.get(n.parentId);
        if (g) map.set(n.id, g);
      }
    }
    return map;
  }, [nodes]);

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [groupSubmenuOpen, setGroupSubmenuOpen] = useState(false);
  const [menuGroups, setMenuGroups] = useState<{ id: string; label: string; color: string }[]>([]);
  const [menuSessionGrouped, setMenuSessionGrouped] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const [defaultShellId, setDefaultShellId] = useState<string | null>(null);

  useEffect(() => {
    window.agentPlex.getShells().then(setShells);
    window.agentPlex.getDefaultShell().then(setDefaultShellId);
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  const handleSessionContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    const allNodes = useAppStore.getState().nodes;
    const groups = allNodes
      .filter((n) => n.type === 'groupNode')
      .map((n) => ({
        id: n.id,
        label: (n.data as { label?: string }).label ?? 'Group',
        color: (n.data as { color?: string }).color ?? '#7aa2f7',
      }));
    const node = allNodes.find((n) => n.id === sessionId);
    setMenuGroups(groups);
    setMenuSessionGrouped(Boolean(node?.parentId));
    setGroupSubmenuOpen(false);
    setContextMenu({ type: 'session', x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleNewGroup = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    createGroupWithMembers([contextMenu.sessionId]);
    setContextMenu(null);
  }, [contextMenu, createGroupWithMembers]);

  const handleAddToExistingGroup = useCallback((groupId: string) => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    addToGroup(groupId, contextMenu.sessionId, { reposition: true });
    setContextMenu(null);
  }, [contextMenu, addToGroup]);

  const handleRemoveFromGroup = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    removeFromGroup(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, removeFromGroup]);

  const handleDirContextMenu = useCallback((e: React.MouseEvent, cwd: string) => {
    e.preventDefault();
    setContextMenu({ type: 'dir', x: e.clientX, y: e.clientY, cwd });
  }, []);

  const handleRename = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    const session = sessions[contextMenu.sessionId];
    if (!session) return;
    setRenameDraft(displayNames[contextMenu.sessionId] || session.title);
    setRenamingId(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, sessions, displayNames]);

  const commitRename = useCallback(() => {
    if (!renamingId) return;
    const trimmed = renameDraft.trim();
    if (trimmed) renameSession(renamingId, trimmed);
    setRenamingId(null);
  }, [renamingId, renameDraft, renameSession]);

  const handleDelete = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    setConfirmDeleteId(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu]);

  const confirmDelete = useCallback(async () => {
    if (!confirmDeleteId) return;
    const session = sessions[confirmDeleteId];
    if (session && session.status !== SessionStatus.Killed) {
      try { await window.agentPlex.killSession(confirmDeleteId); } catch { /* already dead */ }
    }
    removeSession(confirmDeleteId);
    setConfirmDeleteId(null);
  }, [confirmDeleteId, sessions, removeSession]);

  const handleSendMessage = useCallback(() => {
    if (!contextMenu || contextMenu.type !== 'session') return;
    openSendDialog(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, openSendDialog]);

  const handleOpenFolder = useCallback(async () => {
    if (!contextMenu || contextMenu.type !== 'dir') return;
    try { await window.agentPlex.openPath(contextMenu.cwd); } catch { /* ignore */ }
    setContextMenu(null);
  }, [contextMenu]);

  const handleNewSessionInDir = useCallback(async (cli: CliTool) => {
    if (!contextMenu || contextMenu.type !== 'dir') return;
    const cwd = contextMenu.cwd;
    setContextMenu(null);
    const info = await window.agentPlex.createSession(cwd, cli);
    addSession(info);
  }, [contextMenu, addSession]);

  const handleResumeInDir = useCallback((cli: 'claude' | 'copilot' = 'claude') => {
    if (!contextMenu || contextMenu.type !== 'dir') return;
    setContextMenu(null);
    openLauncher('resume', cli);
  }, [contextMenu, openLauncher]);

  const tree = useMemo(() => {
    const dirs = new Map<string, DirEntry>();
    for (const s of Object.values(sessions)) {
      const cwd = s.cwd || 'Unknown';
      if (!dirs.has(cwd)) {
        const dirName = cwd.replace(/\\/g, '/').split('/').pop() || cwd;
        dirs.set(cwd, { cwd, dirName, sessions: [] });
      }
      dirs.get(cwd)!.sessions.push({
        id: s.id,
        label: displayNames[s.id] || s.title,
        status: s.status,
        cli: s.cli,
      });
    }
    return Array.from(dirs.values());
  }, [sessions, displayNames]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  if (tree.length === 0) {
    return (
      <div className="p-4 text-center text-fg-muted text-xs">
        No sessions yet
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((dir) => (
        <div key={dir.cwd}>
          <button
            onClick={() => toggle(dir.cwd)}
            onContextMenu={(e) => handleDirContextMenu(e, dir.cwd)}
            className="flex items-center gap-1.5 w-full h-8 px-3 text-[11px] font-semibold text-fg uppercase tracking-wide hover:bg-elevated transition-colors cursor-pointer"
            title={dir.cwd}
          >
            <span className={`shrink-0 transition-transform duration-150 ${collapsed.has(dir.cwd) ? '' : 'rotate-90'}`}>
              <ChevronRight size={14} />
            </span>
            <span className="truncate">{dir.dirName}</span>
          </button>
          {!collapsed.has(dir.cwd) &&
            dir.sessions.map((s) => {
              const isSelected = openPanes.includes(s.id);
              const isRenaming = renamingId === s.id;
              const group = sessionGroups.get(s.id);
              return (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id, true)}
                  onContextMenu={(e) => handleSessionContextMenu(e, s.id)}
                  style={group ? {
                    backgroundColor: isSelected ? undefined : hexToRgba(group.color, 0.1),
                    boxShadow: `inset 3px 0 0 ${group.color}`,
                  } : undefined}
                  className={`relative flex items-center gap-2 w-full min-h-7 pl-7 pr-3.5 py-1 text-xs transition-colors cursor-pointer
                    ${isSelected
                      ? 'bg-accent-subtle border-l-2 border-accent pl-[26px]'
                      : 'hover:bg-elevated'}`}
                >
                  <CliIcon cli={s.cli} />
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      className="flex-1 min-w-0 text-xs text-fg bg-inset border border-accent rounded px-1 py-0.5 outline-none"
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                        if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null); }
                        e.stopPropagation();
                      }}
                      onClick={(e) => e.stopPropagation()}
                      onMouseDown={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="flex-1 min-w-0 flex flex-col items-start">
                      <span className="truncate max-w-full text-fg">{s.label}</span>
                      {group && (
                        <span
                          className="self-end max-w-full truncate text-[9px] font-semibold uppercase tracking-wide leading-tight"
                          style={{ color: group.color }}
                          title={group.label}
                        >
                          {group.label}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      ))}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed bg-elevated border border-border-strong rounded-lg py-1 min-w-[160px] shadow-[0_8px_24px_var(--shadow-heavy)] z-[1000]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.type === 'session' ? (
            <>
              <button
                className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                onClick={handleRename}
              >
                <Pencil size={12} /> Rename
              </button>
              <button
                className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                onClick={handleSendMessage}
              >
                <Send size={12} /> Send Message
              </button>
              <div className="h-px bg-border my-1" />
              {menuSessionGrouped ? (
                <button
                  className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                  onClick={handleRemoveFromGroup}
                >
                  <Layers size={12} /> Remove from group
                </button>
              ) : (
                <div
                  className="relative"
                  onMouseEnter={() => setGroupSubmenuOpen(true)}
                  onMouseLeave={() => setGroupSubmenuOpen(false)}
                >
                  <button
                    className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                  >
                    <Layers size={12} /> <span className="flex-1">Add to group</span>
                    <ChevronRight size={12} />
                  </button>
                  {groupSubmenuOpen && (
                    <div className="absolute left-full top-0 -mt-1 ml-0.5 bg-elevated border border-border-strong rounded-lg py-1 min-w-[150px] max-h-[280px] overflow-y-auto shadow-[0_8px_24px_var(--shadow-heavy)] z-[1001]">
                      <button
                        className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                        onClick={handleNewGroup}
                      >
                        + New group
                      </button>
                      {menuGroups.length > 0 && <div className="h-px bg-border my-1" />}
                      {menuGroups.map((g) => (
                        <button
                          key={g.id}
                          className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                          onClick={() => handleAddToExistingGroup(g.id)}
                        >
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                          <span className="truncate">{g.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="h-px bg-border my-1" />
              <button
                className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-error bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                onClick={handleDelete}
              >
                <Trash2 size={12} /> Delete
              </button>
            </>
          ) : (
            <>
              <div className="py-1 px-2.5">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-1">
                  <img src={claudeLogo} alt="" className="w-3 h-3" />
                  Claude
                </span>
                <div className="flex gap-1">
                  <button
                    className="flex-1 py-[4px] bg-border border-none rounded text-fg text-[11px] font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={() => handleNewSessionInDir('claude')}
                  >
                    New
                  </button>
                  <button
                    className="flex-1 py-[4px] bg-border border-none rounded text-fg text-[11px] font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={() => handleResumeInDir('claude')}
                  >
                    Resume
                  </button>
                </div>
              </div>
              <div className="h-px bg-border my-1" />
              <div className="py-1 px-2.5">
                <span className="flex items-center gap-1.5 text-[10px] font-semibold text-fg-muted uppercase tracking-wide mb-1">
                  <img
                    src={(document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? copilotLight : copilotDark}
                    alt=""
                    className="w-3 h-3"
                  />
                  GitHub Copilot
                </span>
                <div className="flex gap-1">
                  <button
                    className="flex-1 py-[4px] bg-border border-none rounded text-fg text-[11px] font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={() => handleNewSessionInDir('copilot')}
                  >
                    New
                  </button>
                  <button
                    className="flex-1 py-[4px] bg-border border-none rounded text-fg text-[11px] font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={() => handleResumeInDir('copilot')}
                  >
                    Resume
                  </button>
                </div>
              </div>
              <div className="h-px bg-border my-1" />
              {CLI_TOOLS.filter((t) => t.id !== 'claude' && t.id !== 'copilot').map((tool) => {
                const icons = CLI_ICONS[tool.id];
                const theme = document.documentElement.getAttribute('data-theme') || 'dark';
                const iconSrc = icons ? (theme === 'dark' ? icons.dark : icons.light) : null;
                return (
                  <button
                    key={tool.id}
                    className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                    onClick={() => handleNewSessionInDir(tool.id)}
                  >
                    {iconSrc ? <img src={iconSrc} alt="" className="w-3.5 h-3.5" /> : <Terminal size={13} />}
                    {tool.label}
                  </button>
                );
              })}
              {shells.length > 0 && (
                <>
                  <div className="h-px bg-border my-1" />
                  {shells.map((shell) => (
                    <button
                      key={shell.id}
                      className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                      onClick={() => handleNewSessionInDir(shell.id as CliTool)}
                    >
                      <Terminal size={13} className="text-fg-muted" />
                      {shell.id === defaultShellId && (
                        <Star size={10} className="text-[#f0c040] fill-[#f0c040]" />
                      )}
                      {shell.label}
                    </button>
                  ))}
                </>
              )}
              <div className="h-px bg-border my-1" />
              <button
                className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-fg bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
                onClick={handleOpenFolder}
              >
                <FolderOpen size={12} /> Open Folder
              </button>
            </>
          )}
        </div>
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 bg-backdrop flex items-center justify-center z-[1000]" onClick={() => setConfirmDeleteId(null)}>
          <div className="bg-elevated border border-border-strong rounded-xl p-4 w-[280px] shadow-[0_8px_32px_var(--shadow-heavy)]" onClick={(e) => e.stopPropagation()}>
            <span className="block text-sm font-semibold text-fg mb-1">Delete session?</span>
            <span className="block text-xs text-fg-muted mb-4">This will kill the process and remove the session from the graph.</span>
            <div className="flex gap-2 justify-end">
              <button
                className="py-1.5 px-3 bg-border text-fg border-none rounded-md text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong"
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </button>
              <button
                className="py-1.5 px-3 bg-error text-surface border-none rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-85"
                onClick={confirmDelete}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

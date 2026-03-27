import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { ChevronRight, ChevronDown, Terminal, Pencil, Trash2, Send } from 'lucide-react';
import { useAppStore } from '../../store';
import { SessionStatus, type CliTool } from '../../../shared/ipc-channels';
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

interface DirEntry {
  cwd: string;
  dirName: string;
  sessions: { id: string; label: string; status: SessionStatus; cli: CliTool }[];
}

interface ContextMenu {
  x: number;
  y: number;
  sessionId: string;
}

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const renameSession = useAppStore((s) => s.renameSession);
  const openSendDialog = useAppStore((s) => s.openSendDialog);

  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
  }, []);

  const handleRename = useCallback(() => {
    if (!contextMenu) return;
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
    if (!contextMenu) return;
    setConfirmDeleteId(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu]);

  const confirmDelete = useCallback(() => {
    if (!confirmDeleteId) return;
    const session = sessions[confirmDeleteId];
    if (session && session.status !== SessionStatus.Killed) {
      window.agentPlex.killSession(confirmDeleteId);
    }
    removeSession(confirmDeleteId);
    setConfirmDeleteId(null);
  }, [confirmDeleteId, sessions, removeSession]);

  const handleSendMessage = useCallback(() => {
    if (!contextMenu) return;
    openSendDialog(contextMenu.sessionId);
    setContextMenu(null);
  }, [contextMenu, openSendDialog]);

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
            className="flex items-center gap-2 w-full h-7 px-3.5 text-xs text-fg-muted hover:bg-elevated transition-colors cursor-pointer"
            title={dir.cwd}
          >
            {collapsed.has(dir.cwd) ? (
              <ChevronRight size={12} className="shrink-0" />
            ) : (
              <ChevronDown size={12} className="shrink-0" />
            )}
            <span className="truncate">{dir.dirName}</span>
          </button>
          {!collapsed.has(dir.cwd) &&
            dir.sessions.map((s) => {
              const isSelected = selectedSessionId === s.id;
              const isRenaming = renamingId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  onContextMenu={(e) => handleContextMenu(e, s.id)}
                  className={`flex items-center gap-2 w-full h-7 pl-7 pr-3.5 text-xs transition-colors cursor-pointer
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
                    <span className="truncate text-fg">{s.label}</span>
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
          <button
            className="flex items-center gap-2 w-full py-1.5 px-3 text-[12px] text-error bg-transparent border-none cursor-pointer transition-colors hover:bg-border text-left"
            onClick={handleDelete}
          >
            <Trash2 size={12} /> Delete
          </button>
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

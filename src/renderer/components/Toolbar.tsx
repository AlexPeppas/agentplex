import { useCallback, useEffect, useRef, useState } from 'react';
import { Star, Plus, Radar } from 'lucide-react';
import { useAppStore } from '../store';
import { CLI_TOOLS, type CliTool, type ExternalSession, type DetectedShell } from '../../shared/ipc-channels';
import logoSvg from '../../../assets/logo.svg';
import claudeLogo from '../../../assets/claude-logo.svg';
import codexDark from '../../../assets/codex-dark.svg';
import codexLight from '../../../assets/codex-light.svg';
import copilotDark from '../../../assets/githubcopilot-dark.svg';
import copilotLight from '../../../assets/githubcopilot-light.svg';

const TOOL_ICONS: Record<string, { dark: string; light: string }> = {
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortenPath(cwd: string): string {
  const home = cwd.match(/^\/home\/[^/]+/)?.[0] || '';
  if (home && cwd.startsWith(home)) {
    return '~' + cwd.slice(home.length);
  }
  return cwd;
}

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);
  const openLauncher = useAppStore((s) => s.openLauncher);
  const [menuOpen, setMenuOpen] = useState(false);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [externalSessions, setExternalSessions] = useState<ExternalSession[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [adoptingId, setAdoptingId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const discoverRef = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const [defaultShellId, setDefaultShellId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shellId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const isDarwin = window.agentPlex.platform === 'darwin';

  useEffect(() => {
    window.agentPlex.getShells().then(setShells);
    window.agentPlex.getDefaultShell().then(setDefaultShellId);
  }, []);


  const handleNewClaude = useCallback(() => {
    setMenuOpen(false);
    openLauncher('new', 'claude');
  }, [openLauncher]);

  const handleResume = useCallback(() => {
    setMenuOpen(false);
    openLauncher('resume', 'claude');
  }, [openLauncher]);

  // Non-Claude tools still use the folder picker
  const handlePick = useCallback(async (cli: CliTool) => {
    setMenuOpen(false);
    const cwd = await window.agentPlex.pickDirectory();
    if (!cwd) return;
    const info = await window.agentPlex.createSession(cwd, cli);
    addSession(info);
  }, [addSession]);

  const handleShellContextMenu = useCallback((e: React.MouseEvent, shellId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, shellId });
  }, []);

  const handleSetDefault = useCallback(async (shellId: string) => {
    await window.agentPlex.setDefaultShell(shellId);
    setDefaultShellId(shellId);
    setContextMenu(null);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleDiscover = useCallback(async () => {
    setDiscoverOpen(true);
    setDiscovering(true);
    try {
      const sessions = await window.agentPlex.discoverExternal();
      setExternalSessions(sessions);
    } catch (err) {
      console.error('[discover] Failed:', err);
      setExternalSessions([]);
    } finally {
      setDiscovering(false);
    }
  }, []);

  const handleAdopt = useCallback(async (ext: ExternalSession) => {
    setAdoptingId(ext.sessionId);
    try {
      const info = await window.agentPlex.adoptExternal(ext.sessionId, ext.cwd);
      addSession(info);
      const dirName = ext.cwd.split('/').pop() || ext.cwd;
      const label = ext.name || dirName;
      const renameSession = useAppStore.getState().renameSession;
      renameSession(info.id, label);
      // Remove adopted session from the list
      setExternalSessions((prev) => prev.filter((s) => s.sessionId !== ext.sessionId));
    } catch (err) {
      console.error('[adopt] Failed:', err);
    } finally {
      setAdoptingId(null);
    }
  }, [addSession]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  // Close on Escape
  useEffect(() => {
    if (!menuOpen && !discoverOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        setDiscoverOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [menuOpen, discoverOpen]);

  // Close discover panel on outside click
  useEffect(() => {
    if (!discoverOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (discoverRef.current && !discoverRef.current.contains(e.target as Node)) {
        setDiscoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [discoverOpen]);

  return (
    <div className={`flex items-center gap-2.5 h-12 bg-inset border-b border-border [-webkit-app-region:drag] ${isDarwin ? 'pl-20 pr-[18px]' : 'px-[18px] pr-[140px]'}`}>
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="w-6 h-6 rounded-md overflow-hidden shrink-0 shadow-[0_0_6px_var(--accent-subtle-strong)]">
          <img className="w-full h-full" src={logoSvg} alt="AgentPlex" />
        </div>
        <span className="text-sm font-semibold text-accent tracking-wide flex-1">AgentPlex</span>
      </div>
      <div className="[-webkit-app-region:no-drag] flex items-center gap-2.5">
        <div className="relative" ref={discoverRef}>
          <button
            className="flex items-center gap-1 h-6 px-2 rounded text-fg-muted text-[11px] font-medium cursor-pointer transition-colors hover:bg-elevated hover:text-fg"
            onClick={handleDiscover}
            title="Find running Claude sessions not managed by AgentPlex"
          >
            <Radar size={14} />
            <span>Discover</span>
          </button>
          {discoverOpen && (
            <>
            <div className="fixed inset-0 z-[99] [-webkit-app-region:no-drag]" onClick={() => setDiscoverOpen(false)} />
            <div className="absolute top-[calc(100%+6px)] right-0 bg-elevated border border-border-strong rounded-lg p-1 shadow-[0_8px_24px_var(--shadow-heavy)] z-[100] min-w-[300px] max-h-[360px] overflow-y-auto">
              {discovering ? (
                <div className="py-4 px-3 text-center text-fg-muted text-[13px]">Scanning...</div>
              ) : externalSessions.length === 0 ? (
                <div className="py-4 px-3 text-center text-fg-muted text-[13px]">No external Claude sessions found</div>
              ) : (
                externalSessions.map((ext) => (
                  <div key={ext.sessionId} className="flex items-center gap-2 py-2 px-2.5 rounded-md transition-colors hover:bg-border">
                    <div className="flex-1 min-w-0 flex flex-col gap-px">
                      <span className="text-[13px] font-semibold text-fg whitespace-nowrap overflow-hidden text-ellipsis">
                        {ext.name || ext.cwd.split('/').pop() || 'Claude'}
                      </span>
                      <span className="text-[11px] text-fg-muted">
                        PID {ext.pid} &middot; {formatTimeAgo(ext.startedAt)}
                      </span>
                      <span className="text-[11px] text-fg-muted whitespace-nowrap overflow-hidden text-ellipsis" title={ext.cwd}>
                        {shortenPath(ext.cwd)}
                      </span>
                    </div>
                    <button
                      className="flex-1 py-[5px] bg-border border-none rounded-md text-fg text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong"
                      onClick={() => handleAdopt(ext)}
                      disabled={adoptingId === ext.sessionId}
                    >
                      {adoptingId === ext.sessionId ? '...' : 'Adopt'}
                    </button>
                  </div>
                ))
              )}
            </div>
            </>
          )}
        </div>
        <div className="relative" ref={menuRef}>
          <button
            className="flex items-center gap-1 h-6 px-2 bg-accent text-surface border-none rounded text-[11px] font-semibold cursor-pointer transition-colors hover:bg-accent-hover active:bg-accent-active"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Plus size={14} />
            <span>New Session</span>
          </button>
          {menuOpen && (
            <div className="absolute top-[calc(100%+6px)] right-0 bg-elevated border border-border-strong rounded-lg p-1 min-w-[220px] shadow-[0_8px_24px_var(--shadow-heavy)] z-[100]">
              <div className="py-1.5 px-2.5">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-fg uppercase tracking-wide mb-1.5">
                  <img src={claudeLogo} alt="" className="w-3.5 h-3.5" />
                  Claude
                </span>
                <div className="flex gap-1.5">
                  <button
                    className="flex-1 py-[5px] bg-border border-none rounded-md text-fg text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={handleNewClaude}
                  >
                    New
                  </button>
                  <button
                    className="flex-1 py-[5px] bg-border border-none rounded-md text-fg text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong"
                    onClick={handleResume}
                  >
                    Resume
                  </button>
                </div>
              </div>

              <div className="h-px bg-border my-1" />
              {CLI_TOOLS.filter((t) => t.id !== 'claude').map((tool) => (
                <button
                  key={tool.id}
                  className="flex items-center gap-2 w-full py-2 px-3 bg-transparent border-none rounded-md text-fg text-[13px] font-medium text-left cursor-pointer transition-colors hover:bg-border"
                  onClick={() => handlePick(tool.id)}
                >
                  {TOOL_ICONS[tool.id] && (
                    <img
                      src={(document.documentElement.getAttribute('data-theme') || 'dark') === 'dark' ? TOOL_ICONS[tool.id].dark : TOOL_ICONS[tool.id].light}
                      alt=""
                      className="w-4 h-4"
                    />
                  )}
                  {tool.label}
                </button>
              ))}
              {shells.length > 0 && (
                <>
                  <div className="h-px bg-border my-1" />
                  {shells.map((shell) => (
                    <button
                      key={shell.id}
                      className="block w-full py-2 px-3 bg-transparent border-none rounded-md text-fg text-[13px] font-medium text-left cursor-pointer transition-colors hover:bg-border"
                      onClick={() => handlePick(shell.id as CliTool)}
                      onContextMenu={(e) => handleShellContextMenu(e, shell.id)}
                      title={`Right-click to set as default`}
                    >
                      {shell.id === defaultShellId && (
                        <><Star size={12} className="inline text-[#f0c040] fill-[#f0c040] -mt-px" />{' '}</>
                      )}
                      {shell.label}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="z-[1000] bg-elevated border border-border-strong rounded-md py-1 shadow-[0_8px_24px_var(--shadow-heavy)]"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="block w-full py-2 px-3 bg-transparent border-none rounded-md text-fg text-[13px] font-medium cursor-pointer text-left whitespace-nowrap transition-colors hover:bg-border"
            onClick={() => handleSetDefault(contextMenu.shellId)}
          >
            Set as default
          </button>
        </div>
      )}
    </div>
  );
}

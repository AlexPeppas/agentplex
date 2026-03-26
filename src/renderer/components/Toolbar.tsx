import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { CLI_TOOLS, RESUME_TOOL, type CliTool, type ExternalSession, type DetectedShell } from '../../shared/ipc-channels';
import logoSvg from '../../../assets/logo.svg';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

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
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const menuRef = useRef<HTMLDivElement>(null);
  const discoverRef = useRef<HTMLDivElement>(null);
  const [shells, setShells] = useState<DetectedShell[]>([]);
  const [defaultShellId, setDefaultShellId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; shellId: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.agentPlex.getShells().then(setShells);
    window.agentPlex.getDefaultShell().then(setDefaultShellId);
  }, []);

  // Apply theme to document and notify main process for titlebar
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentplex-theme', theme);
    window.agentPlex.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
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
    <div className="toolbar">
      <img className="toolbar__logo" src={logoSvg} alt="AgentPlex" />
      <span className="toolbar__title">AgentPlex</span>
      <button
        className="toolbar__theme-toggle"
        onClick={toggleTheme}
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      >
        {theme === 'dark' ? '\u2600' : '\u263E'}
      </button>
      <div className="toolbar__new-wrapper" ref={discoverRef}>
        <button
          className="toolbar__button toolbar__button--secondary"
          onClick={handleDiscover}
          title="Find running Claude sessions not managed by AgentPlex"
        >
          Discover
        </button>
        {discoverOpen && (
          <div className="toolbar__menu toolbar__discover-panel">
            {discovering ? (
              <div className="toolbar__discover-empty">Scanning...</div>
            ) : externalSessions.length === 0 ? (
              <div className="toolbar__discover-empty">No external Claude sessions found</div>
            ) : (
              externalSessions.map((ext) => (
                <div key={ext.sessionId} className="toolbar__discover-item">
                  <div className="toolbar__discover-info">
                    <span className="toolbar__discover-name">
                      {ext.name || ext.cwd.split('/').pop() || 'Claude'}
                    </span>
                    <span className="toolbar__discover-meta">
                      PID {ext.pid} &middot; {formatTimeAgo(ext.startedAt)}
                    </span>
                    <span className="toolbar__discover-path" title={ext.cwd}>
                      {shortenPath(ext.cwd)}
                    </span>
                  </div>
                  <button
                    className="toolbar__menu-pill"
                    onClick={() => handleAdopt(ext)}
                    disabled={adoptingId === ext.sessionId}
                  >
                    {adoptingId === ext.sessionId ? '...' : 'Adopt'}
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
      <div className="toolbar__new-wrapper" ref={menuRef}>
        <button
          className="toolbar__button"
          onClick={() => setMenuOpen((v) => !v)}
        >
          + New Session
        </button>
        {menuOpen && (
          <div className="toolbar__menu">
            <div className="toolbar__menu-section">
              <span className="toolbar__menu-label">Claude</span>
              <div className="toolbar__menu-row">
                <button
                  className="toolbar__menu-pill"
                  onClick={handleNewClaude}
                >
                  New
                </button>
                <button
                  className="toolbar__menu-pill"
                  onClick={handleResume}
                >
                  Resume
                </button>
              </div>
            </div>
            <div className="toolbar__menu-divider" />
            {CLI_TOOLS.filter((t) => t.id !== 'claude').map((tool) => (
              <button
                key={tool.id}
                className="toolbar__menu-item"
                onClick={() => handlePick(tool.id)}
              >
                {tool.label}
              </button>
            ))}
            {shells.length > 0 && (
              <>
                <div className="toolbar__menu-divider" />
                {shells.map((shell) => (
                  <button
                    key={shell.id}
                    className="toolbar__menu-item"
                    onClick={() => handlePick(shell.id as CliTool)}
                    onContextMenu={(e) => handleShellContextMenu(e, shell.id)}
                    title={`Right-click to set as default`}
                  >
                    {shell.id === defaultShellId && (
                      <span className="toolbar__default-indicator">{'\u2605'} </span>
                    )}
                    {shell.label}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="toolbar__context-menu"
          style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="toolbar__context-menu-item"
            onClick={() => handleSetDefault(contextMenu.shellId)}
          >
            Set as default
          </button>
        </div>
      )}
    </div>
  );
}

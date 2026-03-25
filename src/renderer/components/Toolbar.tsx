import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { CLI_TOOLS, RESUME_TOOL, type CliTool, type DetectedShell } from '../../shared/ipc-channels';
import logoSvg from '../../../assets/logo.svg';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const menuRef = useRef<HTMLDivElement>(null);
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

  const handlePick = useCallback(async (cli: CliTool) => {
    setMenuOpen(false);
    const cwd = await window.agentPlex.pickDirectory();
    if (!cwd) return;
    const info = await window.agentPlex.createSession(cwd, cli);
    addSession(info);
  }, [addSession]);

  const handleResume = useCallback(async () => {
    setMenuOpen(false);
    const cwd = await window.agentPlex.pickDirectory();
    if (!cwd) return;
    const info = await window.agentPlex.createSession(cwd, RESUME_TOOL.id);
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
    if (!menuOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [menuOpen]);

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
                  onClick={() => handlePick('claude')}
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

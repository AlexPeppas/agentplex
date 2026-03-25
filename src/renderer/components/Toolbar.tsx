import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { CLI_TOOLS, SHELL_TOOLS, type CliTool } from '../../shared/ipc-channels';
import logoSvg from '../../../assets/logo.svg';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);
  const openLauncher = useAppStore((s) => s.openLauncher);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);
  const menuRef = useRef<HTMLDivElement>(null);

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
            <div className="toolbar__menu-divider" />
            <div className="toolbar__menu-section">
              <span className="toolbar__menu-label">Shell</span>
              <div className="toolbar__menu-row">
                {SHELL_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    className="toolbar__menu-pill"
                    onClick={() => handlePick(tool.id)}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

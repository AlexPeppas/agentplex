import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import { CLI_TOOLS, type CliTool } from '../../shared/ipc-channels';

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
      <img className="toolbar__logo" src="/assets/logo.svg" alt="AgentPlex" />
      <span className="toolbar__title">AgentPlex</span>
      <div className="toolbar__new-wrapper" ref={menuRef}>
        <button
          className="toolbar__button"
          onClick={() => setMenuOpen((v) => !v)}
        >
          + New Session
        </button>
        {menuOpen && (
          <div className="toolbar__menu">
            {CLI_TOOLS.map((tool) => (
              <button
                key={tool.id}
                className="toolbar__menu-item"
                onClick={() => handlePick(tool.id)}
              >
                {tool.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

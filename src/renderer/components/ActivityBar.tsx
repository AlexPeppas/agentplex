import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Search, GitBranch, Puzzle, Sun, Moon } from 'lucide-react';
import { useAppStore, type PanelId } from '../store';

const PANELS: { id: PanelId; icon: typeof FolderOpen; disabled?: boolean }[] = [
  { id: 'explorer', icon: FolderOpen },
  { id: 'search', icon: Search },
  { id: 'git', icon: GitBranch, disabled: true },
  { id: 'extensions', icon: Puzzle, disabled: true },
];

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentplex-theme', theme);
    window.agentPlex.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return (
    <div className="flex-none w-12 flex flex-col items-center pt-2 pb-2 gap-1 bg-inset border-r border-border">
      {PANELS.map(({ id, icon: Icon, disabled }) => {
        const isActive = activePanelId === id;
        return (
          <button
            key={id}
            onClick={() => !disabled && togglePanel(id)}
            className={`relative w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-[120ms]
              ${disabled ? 'opacity-40 pointer-events-none' : 'cursor-pointer'}
              ${isActive ? 'bg-elevated text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg'}`}
            title={id.charAt(0).toUpperCase() + id.slice(1)}
          >
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r-sm" />
            )}
            <Icon size={20} />
          </button>
        );
      })}
      <div className="mt-auto">
        <button
          onClick={toggleTheme}
          className="w-9 h-9 flex items-center justify-center rounded-md text-fg-muted cursor-pointer transition-colors duration-[120ms] hover:bg-elevated hover:text-fg"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
        </button>
      </div>
    </div>
  );
}
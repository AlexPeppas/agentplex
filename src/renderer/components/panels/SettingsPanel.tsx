import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Sun, Moon, Columns2 } from 'lucide-react';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function getSplitPaneEnabled(): boolean {
  const val = localStorage.getItem('agentplex-split-pane');
  return val === null ? true : val === 'true';
}

export function SettingsPanel() {
  // Read current theme from the DOM (source of truth) instead of localStorage
  const [theme, setTheme] = useState<'dark' | 'light'>(
    () => (document.documentElement.getAttribute('data-theme') as 'dark' | 'light') || 'dark'
  );
  const [splitPane, setSplitPane] = useState(() => getSplitPaneEnabled());
  const mountedRef = useRef(false);

  useEffect(() => {
    // Skip the initial mount — only apply when user toggles
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentplex-theme', theme);
    window.agentPlex.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const toggleSplitPane = useCallback(() => {
    setSplitPane((prev) => {
      const next = !prev;
      localStorage.setItem('agentplex-split-pane', String(next));
      return next;
    });
  }, []);

  const handleConfigureLaunch = useCallback(async () => {
    try {
      await window.agentPlex.openSettings();
    } catch (err) {
      console.error('Failed to open settings', err);
    }
  }, []);

  return (
    <div className="flex flex-col gap-1 p-3">
      <button
        onClick={toggleTheme}
        className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md bg-elevated hover:bg-border transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          {theme === 'dark' ? <Moon size={13} className="text-fg-muted" /> : <Sun size={13} className="text-fg-muted" />}
          <span className="text-xs text-fg">
            {theme === 'dark' ? 'Dark mode' : 'Light mode'}
          </span>
        </div>
        <span className="text-[10px] text-fg-muted">
          Switch to {theme === 'dark' ? 'light' : 'dark'}
        </span>
      </button>

      <button
        onClick={toggleSplitPane}
        className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md bg-elevated hover:bg-border transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <Columns2 size={13} className="text-fg-muted" />
          <span className="text-xs text-fg">Split pane</span>
        </div>
        <span className="text-[10px] text-fg-muted">
          {splitPane ? 'On' : 'Off'}
        </span>
      </button>

      <button
        onClick={handleConfigureLaunch}
        className="flex items-center justify-between w-full px-2.5 py-1.5 rounded-md bg-elevated hover:bg-border transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <ExternalLink size={13} className="text-fg-muted" />
          <span className="text-xs text-fg">Configure launch</span>
        </div>
        <span className="text-[10px] text-fg-muted">settings.json</span>
      </button>
    </div>
  );
}

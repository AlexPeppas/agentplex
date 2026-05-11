import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Sun, Moon, Columns2, Palette } from 'lucide-react';
import {
  TERMINAL_THEMES,
  getTerminalThemeId,
  setTerminalThemeId,
} from '../../terminalThemes';

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
  const [termThemeId, setTermThemeId] = useState(() => getTerminalThemeId());
  const mountedRef = useRef(false);

  const handleTerminalTheme = useCallback((id: string) => {
    setTermThemeId(id);
    setTerminalThemeId(id);
  }, []);

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

      <div className="flex flex-col gap-1.5 w-full px-2.5 py-1.5 rounded-md bg-elevated">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Palette size={13} className="text-fg-muted" />
            <span className="text-xs text-fg">Terminal color</span>
          </div>
          <span className="text-[10px] text-fg-muted">
            {TERMINAL_THEMES.find((t) => t.id === termThemeId)?.label ?? 'Default'}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TERMINAL_THEMES.map((t) => {
            const active = t.id === termThemeId;
            return (
              <button
                key={t.id}
                onClick={() => handleTerminalTheme(t.id)}
                title={t.label}
                className={`flex items-center gap-1.5 pl-1 pr-2 py-0.5 rounded border transition-colors cursor-pointer ${
                  active
                    ? 'border-accent bg-border'
                    : 'border-transparent hover:border-border'
                }`}
              >
                <span
                  className="w-3.5 h-3.5 rounded-sm border border-border/60"
                  style={{
                    background: t.theme.background,
                    boxShadow: `inset 0 0 0 2px ${t.theme.foreground}33`,
                  }}
                />
                <span className="text-[10px] text-fg">{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

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

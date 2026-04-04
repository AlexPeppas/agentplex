import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Sun, Moon } from 'lucide-react';

function getInitialTheme(): 'dark' | 'light' {
  const saved = localStorage.getItem('agentplex-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return 'dark';
}

export function SettingsPanel() {
  const [theme, setTheme] = useState<'dark' | 'light'>(getInitialTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('agentplex-theme', theme);
    window.agentPlex.setTheme(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const handleConfigureLaunch = useCallback(async () => {
    try {
      await window.agentPlex.openSettings();
    } catch (err) {
      console.error('Failed to open settings', err);
    }
  }, []);

  return (
    <div className="flex flex-col gap-1.5 p-3.5">
      <button
        onClick={toggleTheme}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg bg-elevated hover:bg-border transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2.5">
          {theme === 'dark' ? <Moon size={15} className="text-fg-muted" /> : <Sun size={15} className="text-fg-muted" />}
          <span className="text-[13px] text-fg">
            {theme === 'dark' ? 'Dark mode' : 'Light mode'}
          </span>
        </div>
        <span className="text-[11px] text-fg-muted">
          Switch to {theme === 'dark' ? 'light' : 'dark'}
        </span>
      </button>

      <button
        onClick={handleConfigureLaunch}
        className="flex items-center justify-between w-full px-3 py-2 rounded-lg bg-elevated hover:bg-border transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-2.5">
          <ExternalLink size={15} className="text-fg-muted" />
          <span className="text-[13px] text-fg">Configure launch</span>
        </div>
        <span className="text-[11px] text-fg-muted">settings.json</span>
      </button>
    </div>
  );
}

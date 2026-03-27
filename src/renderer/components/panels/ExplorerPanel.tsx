import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, Terminal } from 'lucide-react';
import { useAppStore } from '../../store';
import type { CliTool, SessionStatus } from '../../../shared/ipc-channels';
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

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);

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
              return (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className={`flex items-center gap-2 w-full h-7 pl-7 pr-3.5 text-xs transition-colors cursor-pointer
                    ${isSelected
                      ? 'bg-accent-subtle border-l-2 border-accent pl-[26px]'
                      : 'hover:bg-elevated'}`}
                >
                  <CliIcon cli={s.cli} />
                  <span className="truncate text-fg">{s.label}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

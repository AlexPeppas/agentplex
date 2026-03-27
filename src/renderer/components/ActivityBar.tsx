import { FolderOpen, Search, GitBranch, Puzzle } from 'lucide-react';
import { useAppStore, type PanelId } from '../store';

const PANELS: { id: PanelId; icon: typeof FolderOpen; disabled?: boolean }[] = [
  { id: 'explorer', icon: FolderOpen },
  { id: 'search', icon: Search },
  { id: 'git', icon: GitBranch, disabled: true },
  { id: 'extensions', icon: Puzzle, disabled: true },
];

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);

  return (
    <div className="flex-none w-12 flex flex-col items-center pt-2 gap-1 bg-inset border-r border-border">
      {PANELS.map(({ id, icon: Icon, disabled }) => {
        const isActive = activePanelId === id;
        return (
          <button
            key={id}
            onClick={() => !disabled && togglePanel(id)}
            className={`relative w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-[120ms]
              ${disabled ? 'opacity-40 cursor-default' : 'cursor-pointer'}
              ${isActive ? 'bg-elevated text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg'}
              ${disabled ? '' : 'hover:text-fg'}`}
            title={id.charAt(0).toUpperCase() + id.slice(1)}
          >
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r-sm" />
            )}
            <Icon size={20} />
          </button>
        );
      })}
    </div>
  );
}
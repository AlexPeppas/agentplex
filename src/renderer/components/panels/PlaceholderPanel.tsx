import { GitBranch, Puzzle } from 'lucide-react';
import type { PanelId } from '../../store';

const PANEL_META: Record<string, { icon: typeof GitBranch; label: string }> = {
  git: { icon: GitBranch, label: 'Source Control' },
  extensions: { icon: Puzzle, label: 'Extensions' },
};

export function PlaceholderPanel({ panelId }: { panelId: PanelId }) {
  const meta = PANEL_META[panelId] || { icon: Puzzle, label: panelId };
  const Icon = meta.icon;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-fg-muted">
      <Icon size={32} className="opacity-40" />
      <span className="text-sm font-medium">{meta.label}</span>
      <span className="text-xs">Coming soon</span>
    </div>
  );
}

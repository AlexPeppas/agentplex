import { useAppStore } from '../store';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { SearchPanel } from './panels/SearchPanel';
import { PlaceholderPanel } from './panels/PlaceholderPanel';

const PANEL_TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  git: 'Source Control',
  extensions: 'Extensions',
};

export function SidePanel() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const sidePanelWidth = useAppStore((s) => s.sidePanelWidth);

  if (!activePanelId) return null;

  const title = PANEL_TITLES[activePanelId] || activePanelId;

  return (
    <div
      className="flex-none flex flex-col h-full bg-primary border-r border-border overflow-hidden"
      style={{ width: sidePanelWidth }}
    >
      <div className="shrink-0 px-3.5 py-2.5 text-[11px] uppercase tracking-widest text-fg-muted border-b border-border">
        {title}
      </div>
      <div className="flex-1 overflow-y-auto">
        {activePanelId === 'explorer' && <ExplorerPanel />}
        {activePanelId === 'search' && <SearchPanel />}
        {(activePanelId === 'git' || activePanelId === 'extensions') && (
          <PlaceholderPanel panelId={activePanelId} />
        )}
      </div>
    </div>
  );
}

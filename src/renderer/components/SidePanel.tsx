import { useAppStore } from '../store';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { SearchPanel } from './panels/SearchPanel';
import { TemplatesPanel } from './panels/TemplatesPanel';
import { SettingsPanel } from './panels/SettingsPanel';

const PANEL_TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  templates: 'Templates',
  settings: 'Settings',
};

export function SidePanel() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const sidePanelWidth = useAppStore((s) => s.sidePanelWidth);

  if (!activePanelId) return null;

  const title = PANEL_TITLES[activePanelId] || activePanelId;

  return (
    <div
      className="flex-none flex flex-col h-full bg-surface border-r border-border overflow-hidden"
      style={{ width: sidePanelWidth }}
    >
      <div className="shrink-0 px-3.5 py-3 text-xs font-medium text-fg border-b border-border-soft">
        {title}
      </div>
      <div className="flex-1 overflow-y-auto">
        {activePanelId === 'explorer' && <ExplorerPanel />}
        {activePanelId === 'search' && <SearchPanel />}
        {activePanelId === 'templates' && <TemplatesPanel />}
        {activePanelId === 'settings' && <SettingsPanel />}
      </div>
    </div>
  );
}

import { useAppStore } from '../store';
import { PlaceholderPanel } from './panels/PlaceholderPanel';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { SessionExplorerPanel } from './panels/SessionExplorerPanel';
import { SearchPanel } from './panels/SearchPanel';

export function SidePanel() {
  const activePanelId = useAppStore((s) => s.activePanelId);

  const panelTitle: Record<string, string> = {
    explorer: 'Explorer',
    sessions: 'Sessions',
    search: 'Search',
    git: 'Git',
    extensions: 'Extensions',
  };

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        {panelTitle[activePanelId || ''] || ''}
      </div>
      <div className="side-panel__content">
        {activePanelId === 'explorer' && <ExplorerPanel />}
        {activePanelId === 'sessions' && <SessionExplorerPanel />}
        {activePanelId === 'search' && <SearchPanel />}
        {activePanelId === 'git' && (
          <PlaceholderPanel icon={'\u2442'} label="Git" />
        )}
        {activePanelId === 'extensions' && (
          <PlaceholderPanel icon={'\u26A1'} label="Extensions" />
        )}
      </div>
    </div>
  );
}

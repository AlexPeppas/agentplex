import { useAppStore, type PanelId } from '../store';

interface PanelDef {
  id: PanelId;
  label: string;
  icon: string;
  enabled: boolean;
}

const PANELS: PanelDef[] = [
  { id: 'explorer', label: 'Explorer', icon: '\u{1F4C1}', enabled: true },
  { id: 'sessions', label: 'Sessions', icon: '\u{1F5A5}', enabled: true },
  { id: 'search', label: 'Search', icon: '\u{1F50D}', enabled: true },
  { id: 'git', label: 'Git', icon: '\u2442', enabled: false },
  { id: 'extensions', label: 'Extensions', icon: '\u26A1', enabled: false },
];

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);

  return (
    <div className="activity-bar">
      {PANELS.map((panel) => (
        <button
          key={panel.id}
          className={`activity-bar__icon ${activePanelId === panel.id ? 'activity-bar__icon--active' : ''} ${!panel.enabled ? 'activity-bar__icon--disabled' : ''}`}
          title={panel.enabled ? panel.label : `${panel.label} (Coming soon)`}
          onClick={() => panel.enabled && togglePanel(panel.id)}
        >
          {panel.icon}
        </button>
      ))}
    </div>
  );
}

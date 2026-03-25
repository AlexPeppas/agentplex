interface PlaceholderPanelProps {
  icon: string;
  label: string;
}

export function PlaceholderPanel({ icon, label }: PlaceholderPanelProps) {
  return (
    <div className="placeholder-panel">
      <span className="placeholder-panel__icon">{icon}</span>
      <span className="placeholder-panel__label">{label}</span>
      <span className="placeholder-panel__text">Coming soon</span>
    </div>
  );
}

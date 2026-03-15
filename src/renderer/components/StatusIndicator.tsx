import { SessionStatus } from '../../shared/ipc-channels';

const STATUS_VAR: Record<SessionStatus, string> = {
  [SessionStatus.Running]: 'var(--success)',
  [SessionStatus.Idle]: 'var(--text-muted)',
  [SessionStatus.WaitingForInput]: 'var(--warning)',
  [SessionStatus.Killed]: 'var(--error)',
};

interface StatusIndicatorProps {
  status: SessionStatus;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const color = STATUS_VAR[status];
  const shouldPulse = status === SessionStatus.Running || status === SessionStatus.WaitingForInput;

  return (
    <span
      className={`status-dot ${shouldPulse ? 'status-dot--pulse' : ''}`}
      style={{ backgroundColor: color }}
    />
  );
}

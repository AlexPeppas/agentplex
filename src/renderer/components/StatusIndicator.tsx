import { SessionStatus } from '../../shared/ipc-channels';

const STATUS_COLORS: Record<SessionStatus, string> = {
  [SessionStatus.Running]: '#50fa7b',
  [SessionStatus.Idle]: '#6272a4',
  [SessionStatus.WaitingForInput]: '#f0c674',
  [SessionStatus.Killed]: '#ff5555',
};

interface StatusIndicatorProps {
  status: SessionStatus;
}

export function StatusIndicator({ status }: StatusIndicatorProps) {
  const color = STATUS_COLORS[status];
  const shouldPulse = status === SessionStatus.Running || status === SessionStatus.WaitingForInput;

  return (
    <span
      className={`status-dot ${shouldPulse ? 'status-dot--pulse' : ''}`}
      style={{ backgroundColor: color }}
    />
  );
}

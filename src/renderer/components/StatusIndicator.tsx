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
      className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${shouldPulse ? 'animate-[pulse-dot_1.5s_ease-in-out_infinite]' : ''}`}
      style={{ backgroundColor: color }}
    />
  );
}

import { useMemo } from 'react';
import { useAppStore } from '../../store';
import { SessionStatus } from '../../../shared/ipc-channels';
import { StatusIndicator } from '../StatusIndicator';

const STATUS_ORDER: Record<SessionStatus, number> = {
  [SessionStatus.WaitingForInput]: 0,
  [SessionStatus.Running]: 1,
  [SessionStatus.Idle]: 2,
  [SessionStatus.Killed]: 3,
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  [SessionStatus.Running]: 'running',
  [SessionStatus.Idle]: 'idle',
  [SessionStatus.WaitingForInput]: 'waiting',
  [SessionStatus.Killed]: 'killed',
};

export function SessionExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const displayNames = useAppStore((s) => s.displayNames);

  const sorted = useMemo(() => {
    return Object.values(sessions).sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    );
  }, [sessions]);

  const dirName = (cwd: string) => cwd.replace(/\\/g, '/').split('/').pop() || cwd;

  if (sorted.length === 0) {
    return <div className="panel-empty">No sessions yet</div>;
  }

  return (
    <div>
      {sorted.map((session) => (
        <div
          key={session.id}
          className={`tree-item ${selectedSessionId === session.id ? 'tree-item--selected' : ''}`}
          onClick={() => selectSession(session.id)}
        >
          <span className="tree-item__status">
            <StatusIndicator status={session.status} />
          </span>
          <span className="tree-item__label">
            {displayNames[session.id] || session.title}
          </span>
          <span className="tree-item__secondary">
            {STATUS_LABEL[session.status]} · {dirName(session.cwd || '')}
          </span>
        </div>
      ))}
    </div>
  );
}

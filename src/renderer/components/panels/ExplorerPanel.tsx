import { useMemo, useState, useEffect } from 'react';
import { useAppStore } from '../../store';
import { StatusIndicator } from '../StatusIndicator';
import type { SessionInfo } from '../../../shared/ipc-channels';

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const displayNames = useAppStore((s) => s.displayNames);

  const tree = useMemo(() => {
    const groups: Record<string, SessionInfo[]> = {};
    for (const session of Object.values(sessions)) {
      const cwd = session.cwd || 'Unknown';
      (groups[cwd] ??= []).push(session);
    }
    return groups;
  }, [sessions]);

  const cwds = Object.keys(tree);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(cwds.map((cwd) => [cwd, true]))
  );

  // Expand newly-appeared directories
  useEffect(() => {
    for (const cwd of cwds) {
      if (!(cwd in expanded)) {
        setExpanded((prev) => ({ ...prev, [cwd]: true }));
      }
    }
  }, [cwds.join(',')]);

  const toggleDir = (cwd: string) => {
    setExpanded((prev) => ({ ...prev, [cwd]: !prev[cwd] }));
  };

  const dirName = (cwd: string) => cwd.replace(/\\/g, '/').split('/').pop() || cwd;

  if (cwds.length === 0) {
    return <div className="panel-empty">No sessions yet</div>;
  }

  return (
    <div>
      {cwds.map((cwd) => (
        <div key={cwd}>
          <div
            className="tree-item tree-item--directory"
            title={cwd}
            onClick={() => toggleDir(cwd)}
          >
            <span className="tree-item__arrow">{expanded[cwd] ? '\u25BE' : '\u25B8'}</span>
            <span className="tree-item__label">{dirName(cwd)}</span>
          </div>
          {expanded[cwd] &&
            tree[cwd].map((session) => (
              <div
                key={session.id}
                className={`tree-item tree-item--session ${selectedSessionId === session.id ? 'tree-item--selected' : ''}`}
                onClick={() => selectSession(session.id)}
              >
                <span className="tree-item__status">
                  <StatusIndicator status={session.status} />
                </span>
                <span className="tree-item__label">
                  {displayNames[session.id] || session.title}
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

import { SessionStatus, type SessionInfo } from '../shared/ipc-channels';

export interface ExplorerFilters {
  query: string;
  status: string;
  cli: string;
}

export interface ExplorerProject {
  cwd: string;
  dirName: string;
  total: number;
  sessions: (SessionInfo & { label: string })[];
}

/** Deliberately exclude live status/activity from ordering: attention has its
 * own inbox, so working sessions never move underneath the pointer. */
export function buildExplorerProjects(
  sessions: SessionInfo[],
  names: Record<string, string>,
  groups: ReadonlyMap<string, { label: string }>,
  filters: ExplorerFilters,
): ExplorerProject[] {
  const dirs = new Map<string, ExplorerProject>();
  const terms = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const session of sessions) {
    const cwd = session.cwd || 'Unknown';
    const dirName = cwd.replace(/\\/g, '/').split('/').pop() || cwd;
    let dir = dirs.get(cwd);
    if (!dir) {
      dir = { cwd, dirName, total: 0, sessions: [] };
      dirs.set(cwd, dir);
    }
    dir.total++;
    const label = names[session.id] || session.title;
    const text = [label, cwd, session.cli, groups.get(session.id)?.label || ''].join(' ').toLowerCase();
    if (!terms.every(term => text.includes(term))) continue;
    if (filters.status !== 'all' && session.status !== filters.status) continue;
    if (filters.cli !== 'all' && session.cli !== filters.cli) continue;
    dir.sessions.push({ ...session, label });
  }
  return [...dirs.values()]
    .filter(dir => dir.sessions.length > 0)
    .map(dir => ({
      ...dir,
      sessions: dir.sessions.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.dirName.localeCompare(b.dirName) || a.cwd.localeCompare(b.cwd));
}

export function attentionSessions(sessions: SessionInfo[], names: Record<string, string>) {
  return sessions
    .filter(session => session.status === SessionStatus.WaitingForInput)
    .map(session => ({ ...session, label: names[session.id] || session.title }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

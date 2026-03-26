import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';
import type { DiscoveredProject, DiscoveredSession } from '../../shared/ipc-channels';

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ProjectLauncher() {
  const launcherMode = useAppStore((s) => s.launcherMode);
  const launcherCli = useAppStore((s) => s.launcherCli);
  const closeLauncher = useAppStore((s) => s.closeLauncher);
  const addSession = useAppStore((s) => s.addSession);

  const [projects, setProjects] = useState<DiscoveredProject[]>([]);
  const [sessions, setSessions] = useState<DiscoveredSession[]>([]);
  const [selectedProject, setSelectedProject] = useState<DiscoveredProject | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);

  // Load projects on mount
  useEffect(() => {
    setLoading(true);
    window.agentPlex.scanProjects().then((p) => {
      console.log('[launcher] got projects:', JSON.stringify(p?.length));
      setProjects(Array.isArray(p) ? p : []);
      setLoading(false);
    }).catch((err) => {
      console.error('[launcher] scanProjects failed:', err);
      setLoading(false);
    });
  }, []);

  // Focus search input
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Load sessions when project selected in resume mode
  useEffect(() => {
    if (launcherMode !== 'resume' || !selectedProject?.encodedPath) {
      setSessions([]);
      return;
    }
    setSessionsLoading(true);
    window.agentPlex.scanSessions(selectedProject.encodedPath).then((s) => {
      setSessions(s);
      setSessionsLoading(false);
    }).catch(() => setSessionsLoading(false));
  }, [selectedProject, launcherMode]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selectedProject && launcherMode === 'resume') {
          setSelectedProject(null);
        } else {
          closeLauncher();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeLauncher, selectedProject, launcherMode]);

  const handleProjectClick = useCallback(async (project: DiscoveredProject) => {
    if (launcherMode === 'new') {
      closeLauncher();
      try {
        // Resolve the real filesystem path lazily from JSONL
        const resolvedPath = project.encodedPath
          ? (await window.agentPlex.resolveProjectPath(project.encodedPath)) || project.realPath
          : project.realPath;
        const info = await window.agentPlex.createSession(resolvedPath, launcherCli);
        addSession(info);
      } catch (err) {
        console.error('Failed to create session:', err);
      }
    } else {
      setSelectedProject(project);
    }
  }, [launcherMode, launcherCli, closeLauncher, addSession]);

  const handleSessionClick = useCallback(async (session: DiscoveredSession) => {
    closeLauncher();
    try {
      const info = await window.agentPlex.createSession(session.projectPath, 'claude', session.sessionId);
      addSession(info);
    } catch (err) {
      console.error('Failed to resume session:', err);
    }
  }, [closeLauncher, addSession]);

  const handleBrowse = useCallback(async () => {
    const cwd = await window.agentPlex.pickDirectory();
    if (!cwd) return;
    closeLauncher();
    try {
      const info = await window.agentPlex.createSession(cwd, launcherCli);
      addSession(info);
    } catch (err) {
      console.error('Failed to create session:', err);
    }
  }, [launcherCli, closeLauncher, addSession]);

  const handleTogglePin = useCallback(async (project: DiscoveredProject, e: React.MouseEvent) => {
    e.stopPropagation();
    const currentPins = await window.agentPlex.getPinnedProjects();
    let newPins;
    if (project.isPinned) {
      newPins = currentPins.filter((p) => p.path !== project.realPath);
    } else {
      newPins = [...currentPins, { path: project.realPath, label: project.dirName }];
    }
    await window.agentPlex.updatePinnedProjects(newPins);
    setProjects((prev) =>
      prev.map((p) =>
        p.realPath === project.realPath ? { ...p, isPinned: !p.isPinned } : p
      )
    );
  }, []);

  const query = searchQuery.toLowerCase();
  const filteredProjects = projects.filter((p) =>
    p.dirName.toLowerCase().includes(query) || p.realPath.toLowerCase().includes(query)
  );
  const filteredSessions = sessions.filter((s) =>
    !query ||
    (s.customTitle || '').toLowerCase().includes(query) ||
    (s.gitBranch || '').toLowerCase().includes(query) ||
    (s.firstUserMessage || '').toLowerCase().includes(query)
  );

  const pinnedProjects = filteredProjects.filter((p) => p.isPinned);
  const recentProjects = filteredProjects.filter((p) => !p.isPinned);

  // Enter in search bar: if text looks like a path, use it directly; otherwise open folder picker
  const handleSearchKeyDown = useCallback(async (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const text = searchQuery.trim();
    const looksLikePath = /^([A-Za-z]:[/\\]|\/|\\\\)/.test(text);
    if (looksLikePath && text.length > 2) {
      closeLauncher();
      try {
        const info = await window.agentPlex.createSession(text, launcherCli);
        addSession(info);
      } catch (err) {
        console.error('Failed to create session:', err);
      }
    } else if (filteredProjects.length === 0) {
      handleBrowse();
    } else if (filteredProjects.length === 1) {
      handleProjectClick(filteredProjects[0]);
    }
  }, [searchQuery, filteredProjects, launcherCli, closeLauncher, addSession, handleBrowse, handleProjectClick]);

  const showSessions = launcherMode === 'resume' && selectedProject;

  return (
    <div className="project-launcher__backdrop" onClick={closeLauncher}>
      <div className="project-launcher" onClick={(e) => e.stopPropagation()}>
        <div className="project-launcher__header">
          <span>{launcherMode === 'new' ? 'Open Project' : 'Resume Session'}</span>
          {showSessions && (
            <button
              className="project-launcher__back"
              onClick={() => setSelectedProject(null)}
            >
              &larr; Back
            </button>
          )}
        </div>

        <div className="project-launcher__search-row">
          <input
            ref={searchRef}
            className="project-launcher__search"
            type="text"
            placeholder={showSessions ? 'Search sessions...' : 'Search or paste a path...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {!showSessions && (
            <button
              className="project-launcher__browse-icon"
              onClick={handleBrowse}
              title="Browse for folder"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}
        </div>

        <div className="project-launcher__body">
          {!showSessions ? (
            <div className="project-launcher__projects">
              {loading && <div className="project-launcher__empty">Scanning projects...</div>}

              {!loading && pinnedProjects.length > 0 && (
                <>
                  <div className="project-launcher__section-label">Pinned</div>
                  {pinnedProjects.map((p) => (
                    <ProjectRow
                      key={p.realPath}
                      project={p}
                      onClick={handleProjectClick}
                      onTogglePin={handleTogglePin}
                    />
                  ))}
                </>
              )}

              {!loading && recentProjects.length > 0 && (
                <>
                  <div className="project-launcher__section-label">Recent</div>
                  {recentProjects.map((p) => (
                    <ProjectRow
                      key={p.realPath}
                      project={p}
                      onClick={handleProjectClick}
                      onTogglePin={handleTogglePin}
                    />
                  ))}
                </>
              )}

              {!loading && filteredProjects.length === 0 && (
                <div className="project-launcher__empty">
                  No projects found. Paste a path above or click the folder icon to browse.
                </div>
              )}
            </div>
          ) : (
            <div className="project-launcher__sessions">
              <div className="project-launcher__session-header">
                {selectedProject.dirName}
              </div>

              {sessionsLoading && <div className="project-launcher__empty">Loading sessions...</div>}

              {!sessionsLoading && filteredSessions.length === 0 && (
                <div className="project-launcher__empty">No sessions found</div>
              )}

              {!sessionsLoading && filteredSessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="project-launcher__session-row"
                  onClick={() => handleSessionClick(s)}
                >
                  <div className="project-launcher__session-title">
                    {s.customTitle || s.sessionId.slice(0, 8) + '...'}
                  </div>
                  <div className="project-launcher__session-meta">
                    {s.gitBranch && (
                      <span className="project-launcher__branch-badge">{s.gitBranch}</span>
                    )}
                    <span className="project-launcher__session-time">
                      {relativeTime(s.lastTimestamp)}
                    </span>
                  </div>
                  {s.firstUserMessage && (
                    <div className="project-launcher__session-preview">
                      {s.firstUserMessage}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectRow({
  project,
  onClick,
  onTogglePin,
}: {
  project: DiscoveredProject;
  onClick: (p: DiscoveredProject) => void;
  onTogglePin: (p: DiscoveredProject, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="project-launcher__project-row"
      onClick={() => onClick(project)}
    >
      <button
        className={`project-launcher__pin-star ${project.isPinned ? 'project-launcher__pin-star--active' : ''}`}
        onClick={(e) => onTogglePin(project, e)}
        title={project.isPinned ? 'Unpin' : 'Pin'}
      >
        {project.isPinned ? '\u2605' : '\u2606'}
      </button>
      <div className="project-launcher__project-info">
        <div className="project-launcher__project-name">{project.dirName}</div>
        <div className="project-launcher__project-path">{project.realPath}</div>
      </div>
      <div className="project-launcher__project-meta">
        {project.sessionCount > 0 && (
          <span className="project-launcher__session-count">
            {project.sessionCount}
          </span>
        )}
        {project.lastActivity && (
          <span className="project-launcher__project-time">
            {relativeTime(project.lastActivity)}
          </span>
        )}
      </div>
    </div>
  );
}

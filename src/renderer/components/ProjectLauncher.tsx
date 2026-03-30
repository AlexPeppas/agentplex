import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderOpen, Star, ArrowLeft } from 'lucide-react';
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
    <div className="fixed inset-0 bg-backdrop flex items-center justify-center z-[1000]" onClick={closeLauncher}>
      <div className="bg-elevated border border-border-strong rounded-xl w-[600px] max-w-[90vw] max-h-[70vh] flex flex-col shadow-[0_8px_32px_var(--shadow-heavy)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between pt-3.5 px-4 text-sm font-semibold text-fg">
          <span>{launcherMode === 'new' ? 'Open Project' : 'Resume Session'}</span>
          {showSessions && (
            <button
              className="bg-transparent border border-border rounded-md text-fg-muted text-xs py-[3px] px-2.5 cursor-pointer transition-colors hover:bg-border hover:text-fg inline-flex items-center gap-1"
              onClick={() => setSelectedProject(null)}
            >
              <ArrowLeft size={12} /> Back
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 mx-4 my-2.5">
          <input
            ref={searchRef}
            className="flex-1 py-2 px-3 bg-surface border border-border-strong rounded-lg text-fg text-[13px] outline-none transition-colors placeholder:text-fg-muted focus:border-accent"
            type="text"
            placeholder={showSessions ? 'Search sessions...' : 'Search or paste a path...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleSearchKeyDown}
          />
          {!showSessions && (
            <button
              className="shrink-0 w-[34px] h-[34px] flex items-center justify-center bg-surface border border-border-strong rounded-lg text-fg-muted cursor-pointer transition-colors hover:bg-border hover:text-accent hover:border-accent"
              onClick={handleBrowse}
              title="Browse for folder"
            >
              <FolderOpen size={16} />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {!showSessions ? (
            <div>
              {loading && <div className="py-5 px-2 text-[13px] text-fg-muted text-center">Scanning projects...</div>}

              {!loading && pinnedProjects.length > 0 && (
                <>
                  <div className="text-[11px] font-semibold text-fg-muted uppercase tracking-wide py-2 px-2">Pinned</div>
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
                  <div className="text-[11px] font-semibold text-fg-muted uppercase tracking-wide py-2 px-2">Recent</div>
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
                <div className="py-5 px-2 text-[13px] text-fg-muted text-center">
                  No projects found. Paste a path above or click the folder icon to browse.
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="text-[13px] font-semibold text-accent py-1 px-2">
                {selectedProject.dirName}
              </div>

              {sessionsLoading && <div className="py-5 px-2 text-[13px] text-fg-muted text-center">Loading sessions...</div>}

              {!sessionsLoading && filteredSessions.length === 0 && (
                <div className="py-5 px-2 text-[13px] text-fg-muted text-center">No sessions found</div>
              )}

              {!sessionsLoading && filteredSessions.map((s) => (
                <div
                  key={s.sessionId}
                  className="py-2 px-2.5 rounded-lg cursor-pointer transition-colors hover:bg-border"
                  onClick={() => handleSessionClick(s)}
                >
                  <div className="text-[13px] font-medium text-fg whitespace-nowrap overflow-hidden text-ellipsis">
                    {s.customTitle || s.sessionId.slice(0, 8) + '...'}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {s.gitBranch && (
                      <span className="text-[10px] font-medium text-accent bg-accent-subtle py-px px-1.5 rounded whitespace-nowrap max-w-[200px] overflow-hidden text-ellipsis">{s.gitBranch}</span>
                    )}
                    <span className="text-[11px] text-fg-muted whitespace-nowrap">
                      {relativeTime(s.lastTimestamp)}
                    </span>
                  </div>
                  {s.firstUserMessage && (
                    <div className="text-[11px] text-fg-muted mt-[3px] whitespace-nowrap overflow-hidden text-ellipsis">
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
      className="flex items-center gap-2 p-2 rounded-lg cursor-pointer transition-colors hover:bg-border"
      onClick={() => onClick(project)}
    >
      <button
        className={`shrink-0 bg-transparent border-none text-sm cursor-pointer px-0.5 transition-colors hover:text-warning ${project.isPinned ? 'text-warning' : 'text-fg-muted'}`}
        onClick={(e) => onTogglePin(project, e)}
        title={project.isPinned ? 'Unpin' : 'Pin'}
      >
        <Star size={14} className={project.isPinned ? 'fill-current' : ''} />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg whitespace-nowrap overflow-hidden text-ellipsis">{project.dirName}</div>
        <div className="text-[11px] text-fg-muted whitespace-nowrap overflow-hidden text-ellipsis">{project.realPath}</div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {project.sessionCount > 0 && (
          <span className="text-[11px] font-semibold text-accent bg-accent-subtle py-px px-1.5 rounded-[10px]">
            {project.sessionCount}
          </span>
        )}
        {project.lastActivity && (
          <span className="text-[11px] text-fg-muted whitespace-nowrap">
            {relativeTime(project.lastActivity)}
          </span>
        )}
      </div>
    </div>
  );
}

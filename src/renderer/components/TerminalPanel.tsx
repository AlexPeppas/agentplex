import { useRef, lazy, Suspense, useEffect, useCallback, useState } from 'react';
import { X, GitBranch, Maximize2, Minimize2, FolderOpen } from 'lucide-react';
import { CliIcon } from './CliIcon';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';
import { defineAgentPlexTheme } from '../monaco-theme';
import { SessionStatus } from '../../shared/ipc-channels';
import { StatusIndicator } from './StatusIndicator';
import { WorkspaceExplorer } from './WorkspaceExplorer';
import { ContextMeter, SessionAge } from './SessionMetrics';

// Lazy-load GitDiffPanel so Monaco is only loaded when needed
const GitDiffPanel = lazy(() =>
  import('./GitDiffPanel').then((m) => ({ default: m.GitDiffPanel }))
);
const ArtifactPreview = lazy(() => import('./ArtifactPreview').then(module => ({ default: module.ArtifactPreview })));

// Initialize Monaco theme once
let themeInitialized = false;

/** A single terminal pane for one session */
function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionTitle = useAppStore(
    (s) => s.displayNames[sessionId] || s.sessions[sessionId]?.title || sessionId
  );
  const cli = useAppStore((s) => s.sessions[sessionId]?.cli);
  const session = useAppStore((s) => s.sessions[sessionId]);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const closePane = useAppStore((s) => s.closePane);
  const terminalFullscreen = useAppStore((s) => s.terminalFullscreen);
  const toggleTerminalFullscreen = useAppStore((s) => s.toggleTerminalFullscreen);
  const [terminalTab, setTerminalTab] = useState('session');
  const [files, setFiles] = useState<string[]>([]);
  const [showFiles, setShowFiles] = useState(true);
  const [branchName, setBranchName] = useState<string | null>(null);
  const isActive = activePaneId === sessionId;
  const sessionStatus = session?.status;

  const openFile = useCallback((reference: string) => {
    setFiles(previous => previous.includes(reference) ? previous : [...previous, reference]);
    setTerminalTab(`file:${reference}`);
  }, []);
  useTerminal(containerRef, sessionId, openFile);

  // Initialize Monaco theme on first git tab open
  useEffect(() => {
    if (terminalTab === 'git' && !themeInitialized) {
      themeInitialized = true;
      defineAgentPlexTheme();
    }
  }, [terminalTab]);

  useEffect(() => {
    if (!sessionStatus || sessionStatus === SessionStatus.Killed) return;
    let cancelled = false;
    const refresh = () => {
      window.agentPlex.gitBranchInfo(sessionId)
        .then((info) => { if (!cancelled) setBranchName(info?.current ?? null); })
        .catch(() => { if (!cancelled) setBranchName(null); });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, sessionStatus]);

  const handleActivate = useCallback(() => {
    useAppStore.getState().openPane(sessionId);
  }, [sessionId]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closePane(sessionId);
  }, [sessionId, closePane]);

  return (
    <div
      className={`terminal-pane flex flex-col flex-1 min-w-0 min-h-0 h-full ${isActive ? '' : 'opacity-80'}`}
      onClick={handleActivate}
    >
      {/* Pane header */}
      <div className={`terminal-pane__header flex shrink-0 items-center justify-between py-0 px-1 bg-surface border-b ${isActive ? 'border-accent-border' : 'border-border'}`}>
        <div className="flex items-center gap-0.5 min-w-0 overflow-x-auto">
          <button
            className={`flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium border-b transition-colors ${
              terminalTab === 'session'
                ? 'text-fg border-accent'
                : 'text-fg-muted border-transparent hover:text-fg'
            }`}
            onClick={() => setTerminalTab('session')}
          >
            <CliIcon cli={cli} size={12} />
            {sessionTitle}
          </button>
          <button
            className={`flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium border-b transition-colors ${
              terminalTab === 'git'
                ? 'text-fg border-accent'
                : 'text-fg-muted border-transparent hover:text-fg'
            }`}
            onClick={() => setTerminalTab('git')}
          >
            <GitBranch size={12} />
            Git
          </button>
          {files.map(reference => (
            <div key={reference} className={`flex items-center shrink-0 text-xs border-b ${terminalTab === `file:${reference}` ? 'border-accent text-fg' : 'border-transparent text-fg-muted'}`}>
              <button className="px-2 py-2 max-w-[160px] truncate" title={reference} onClick={() => setTerminalTab(`file:${reference}`)}>
                {reference.split(/[\\/]/).pop()}
              </button>
              <button aria-label={`Close ${reference}`} className="p-1" onClick={() => {
                setFiles(previous => previous.filter(file => file !== reference));
                if (terminalTab === `file:${reference}`) setTerminalTab('session');
              }}><X size={11} /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 pr-1">
          <button title="Toggle workspace files (pane must be at least 520px wide)" aria-label="Toggle workspace files" aria-pressed={showFiles} className="p-1 text-fg-muted rounded hover:bg-accent-subtle hover:text-fg" onClick={() => setShowFiles(!showFiles)}><FolderOpen size={14} /></button>
          <button
            className="bg-transparent border-none text-fg-muted text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-accent-subtle hover:text-fg"
            onClick={toggleTerminalFullscreen}
            title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {terminalFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="bg-transparent border-none text-fg-muted text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-accent-subtle hover:text-fg"
            onClick={handleClose}
            title="Close pane"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {session && terminalTab === 'session' && (
        <div className="flex shrink-0 items-center gap-3 min-h-9 px-3 py-1.5 bg-surface border-b border-border overflow-hidden">
          <span className="flex items-center gap-1.5 shrink-0">
            <StatusIndicator status={session.status} />
            <span className="text-[10px] font-semibold text-fg capitalize">
              {session.status.replace(/-/g, ' ')}
            </span>
          </span>
          <div className="h-4 w-px bg-border shrink-0" />
          <ContextMeter usage={session.usage} supported={session.telemetrySupported} />
          {session.readOnly && <span className="text-[10px] text-fg-muted shrink-0" title="This CLI owns its original terminal. AgentPlex only monitors its log.">Live log - read only</span>}
          <div className="h-4 w-px bg-border shrink-0" />
          <SessionAge startedAt={session.startedAt} lastActivityAt={session.lastActivityAt} />
          {branchName && (
            <>
              <div className="h-4 w-px bg-border shrink-0" />
              <span className="flex items-center gap-1 min-w-0 text-[10px] text-fg-muted" title={branchName}>
                <GitBranch size={11} className="shrink-0" />
                <span className="truncate">{branchName}</span>
              </span>
            </>
          )}
          <span className="ml-auto flex items-center gap-1 min-w-0 text-[10px] text-fg-muted" title={session.cwd}>
            <FolderOpen size={11} className="shrink-0" />
            <span className="truncate max-w-[180px]">{session.cwd}</span>
          </span>
        </div>
      )}

      <div className="flex flex-1 min-h-0 min-w-0">
      {showFiles && session && <WorkspaceExplorer sessionId={sessionId} cwd={session.cwd} onOpenFile={openFile} />}
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
      {/* Terminal body */}
      <div
        className="terminal-body flex-1 min-h-0 min-w-0 p-1 overflow-hidden bg-terminal"
        style={{ display: terminalTab === 'session' ? undefined : 'none' }}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {/* Git diff panel */}
      {terminalTab === 'git' && (
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-sm text-fg-muted">
                Loading editor...
              </div>
            }
          >
            <GitDiffPanel sessionId={sessionId} />
          </Suspense>
        </div>
      )}
      {files.map(reference => <div key={reference} className="flex-1 min-h-0 overflow-hidden" style={{ display: terminalTab === `file:${reference}` ? undefined : 'none' }}>
        <Suspense fallback={<div className="p-4 text-fg-muted">Loading preview...</div>}>
          <ArtifactPreview sessionId={sessionId} cwd={session?.cwd || ''} reference={reference} onOpenFile={openFile} />
        </Suspense>
      </div>)}
      </div>
      </div>
    </div>
  );
}

export function TerminalPanel() {
  const openPanes = useAppStore((s) => s.openPanes);

  if (openPanes.length === 0) return null;

  return (
    <div className="flex h-full bg-surface">
      {openPanes.map((sessionId, idx) => (
        <div key={sessionId} className="flex flex-1 min-w-0 h-full">
          {idx > 0 && (
            <div className="flex-[0_0_1px] bg-border" />
          )}
          <TerminalPane sessionId={sessionId} />
        </div>
      ))}
    </div>
  );
}

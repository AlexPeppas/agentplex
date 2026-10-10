import { useRef, lazy, Suspense, useEffect, useCallback, useState } from 'react';
import { X, GitBranch, Terminal, Maximize2, Minimize2, FolderOpen, FolderTree } from 'lucide-react';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';
import { defineAgentPlexTheme } from '../monaco-theme';
import type { CliTool } from '../../shared/ipc-channels';
import { SessionStatus } from '../../shared/ipc-channels';
import { StatusIndicator } from './StatusIndicator';
import { ContextMeter, SessionAge } from './SessionMetrics';
import { SessionTerminalView } from './SessionTerminalView';
import claudeLogo from '../../../assets/claude-logo.svg';
import codexDark from '../../../assets/codex-dark.svg';
import codexLight from '../../../assets/codex-light.svg';
import copilotDark from '../../../assets/githubcopilot-dark.svg';
import copilotLight from '../../../assets/githubcopilot-light.svg';

const CLI_ICONS: Record<string, { dark: string; light: string }> = {
  claude: { dark: claudeLogo, light: claudeLogo },
  codex: { dark: codexLight, light: codexDark },
  copilot: { dark: copilotLight, light: copilotDark },
};

function CliIcon({ cli, size = 12 }: { cli?: CliTool; size?: number }) {
  if (!cli) return <Terminal size={size} className="shrink-0" />;
  const icons = CLI_ICONS[cli];
  if (!icons) return <Terminal size={size} className="shrink-0" />;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  return <img src={theme === 'dark' ? icons.dark : icons.light} alt="" style={{ width: size, height: size }} className="shrink-0" />;
}

// Lazy-load GitDiffPanel so Monaco is only loaded when needed
const GitDiffPanel = lazy(() =>
  import('./GitDiffPanel').then((m) => ({ default: m.GitDiffPanel }))
);

// Lazy-load FilesPanel
const FilesPanel = lazy(() =>
  import('./FilesPanel').then((m) => ({ default: m.FilesPanel }))
);

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
  const [terminalTab, setTerminalTabState] = useState<'session' | 'files' | 'git' | 'terminal'>(() => {
    try {
      return (sessionStorage.getItem(`agentplex:tab:${sessionId}`) as any) || 'session';
    } catch {
      return 'session';
    }
  });

  const setTerminalTab = useCallback((tab: 'session' | 'files' | 'git' | 'terminal') => {
    setTerminalTabState(tab);
    try {
      sessionStorage.setItem(`agentplex:tab:${sessionId}`, tab);
    } catch {
      // ignore
    }
  }, [sessionId]);
  const [branchName, setBranchName] = useState<string | null>(null);
  const isActive = activePaneId === sessionId;
  const sessionStatus = session?.status;

  useTerminal(containerRef, sessionId);

  // Initialize Monaco theme on first files or git tab open
  useEffect(() => {
    if ((terminalTab === 'git' || terminalTab === 'files') && !themeInitialized) {
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
      className={`flex flex-col flex-1 min-w-0 min-h-0 h-full ${isActive ? '' : 'opacity-80'}`}
      onClick={handleActivate}
    >
      {/* Pane header */}
      <div className={`flex shrink-0 items-center justify-between py-0 px-1 bg-surface border-b ${isActive ? 'border-accent' : 'border-border'}`}>
        <div className="flex items-center gap-0.5">
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
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
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'files'
                ? 'text-fg border-accent'
                : 'text-fg-muted border-transparent hover:text-fg'
            }`}
            onClick={() => setTerminalTab('files')}
          >
            <FolderTree size={12} />
            Files
          </button>
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'git'
                ? 'text-fg border-accent'
                : 'text-fg-muted border-transparent hover:text-fg'
            }`}
            onClick={() => setTerminalTab('git')}
          >
            <GitBranch size={12} />
            Git
          </button>
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'terminal'
                ? 'text-fg border-accent'
                : 'text-fg-muted border-transparent hover:text-fg'
            }`}
            onClick={() => setTerminalTab('terminal')}
          >
            <Terminal size={12} />
            Terminal
          </button>
        </div>
        <div className="flex items-center gap-1 pr-1">
          <button
            className="bg-transparent border-none text-fg-muted text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-elevated hover:text-fg"
            onClick={toggleTerminalFullscreen}
            title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {terminalFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="bg-transparent border-none text-fg-muted text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-elevated hover:text-fg"
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

      {/* Agent Terminal body */}
      <div
        className="terminal-body flex-1 min-h-0 min-w-0 p-1 overflow-hidden"
        style={{ display: terminalTab === 'session' ? undefined : 'none' }}
      >
        <div ref={containerRef} className="h-full w-full overflow-hidden" />
      </div>

      {/* Files panel */}
      {terminalTab === 'files' && (
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-xs text-fg-muted">
                Loading files...
              </div>
            }
          >
            <FilesPanel sessionId={sessionId} />
          </Suspense>
        </div>
      )}

      {/* Git diff panel */}
      {terminalTab === 'git' && (
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-xs text-fg-muted">
                Loading editor...
              </div>
            }
          >
            <GitDiffPanel sessionId={sessionId} />
          </Suspense>
        </div>
      )}

      {/* Session root terminal shell */}
      {terminalTab === 'terminal' && (
        <div className="flex-1 overflow-hidden">
          <SessionTerminalView sessionId={sessionId} isVisible={true} />
        </div>
      )}
    </div>
  );
}

export function TerminalPanel() {
  const openPanes = useAppStore((s) => s.openPanes);

  if (openPanes.length === 0) return null;

  return (
    <div className="flex h-full bg-inset nowheel nopan nodrag nokey">
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

import { useRef, lazy, Suspense, useEffect, useCallback, useState } from 'react';
import { X, GitBranch, Terminal, Maximize2, Minimize2 } from 'lucide-react';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';
import { defineAgentPlexTheme } from '../monaco-theme';
import type { CliTool } from '../../shared/ipc-channels';
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

// Initialize Monaco theme once
let themeInitialized = false;

/** A single terminal pane for one session */
function TerminalPane({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionTitle = useAppStore(
    (s) => s.displayNames[sessionId] || s.sessions[sessionId]?.title || sessionId
  );
  const cli = useAppStore((s) => s.sessions[sessionId]?.cli);
  const activePaneId = useAppStore((s) => s.activePaneId);
  const closePane = useAppStore((s) => s.closePane);
  const terminalFullscreen = useAppStore((s) => s.terminalFullscreen);
  const toggleTerminalFullscreen = useAppStore((s) => s.toggleTerminalFullscreen);
  const [terminalTab, setTerminalTab] = useState<'session' | 'git'>('session');
  const isActive = activePaneId === sessionId;

  useTerminal(containerRef, sessionId);

  // Initialize Monaco theme on first git tab open
  useEffect(() => {
    if (terminalTab === 'git' && !themeInitialized) {
      themeInitialized = true;
      defineAgentPlexTheme();
    }
  }, [terminalTab]);

  const handleActivate = useCallback(() => {
    useAppStore.getState().openPane(sessionId);
  }, [sessionId]);

  const handleClose = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    closePane(sessionId);
  }, [sessionId, closePane]);

  return (
    <div
      className={`flex flex-col flex-1 min-w-0 h-full ${isActive ? '' : 'opacity-80'}`}
      onClick={handleActivate}
    >
      {/* Pane header */}
      <div className={`flex items-center justify-between py-0 px-1 bg-[#262420] border-b ${isActive ? 'border-[#d18a7a]' : 'border-[#3e3830]'}`}>
        <div className="flex items-center gap-0.5">
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'session'
                ? 'text-[#ece4d8] border-[#d18a7a]'
                : 'text-[#9a8a70] border-transparent hover:text-[#ece4d8]'
            }`}
            onClick={() => setTerminalTab('session')}
          >
            <CliIcon cli={cli} size={12} />
            {sessionTitle}
          </button>
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'git'
                ? 'text-[#ece4d8] border-[#d18a7a]'
                : 'text-[#9a8a70] border-transparent hover:text-[#ece4d8]'
            }`}
            onClick={() => setTerminalTab('git')}
          >
            <GitBranch size={12} />
            Git
          </button>
        </div>
        <div className="flex items-center gap-1 pr-1">
          <button
            className="bg-transparent border-none text-[#9a8a70] text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-[#3e3830] hover:text-[#ece4d8]"
            onClick={toggleTerminalFullscreen}
            title={terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {terminalFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="bg-transparent border-none text-[#9a8a70] text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-[#3e3830] hover:text-[#ece4d8]"
            onClick={handleClose}
            title="Close pane"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Terminal body */}
      <div
        className="terminal-body flex-1 p-1 overflow-hidden"
        ref={containerRef}
        style={{ display: terminalTab === 'session' ? undefined : 'none' }}
      />

      {/* Git diff panel */}
      {terminalTab === 'git' && (
        <div className="flex-1 overflow-hidden">
          <Suspense
            fallback={
              <div className="flex items-center justify-center h-full text-sm text-[#6a5e50]">
                Loading editor...
              </div>
            }
          >
            <GitDiffPanel sessionId={sessionId} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

export function TerminalPanel() {
  const openPanes = useAppStore((s) => s.openPanes);

  if (openPanes.length === 0) return null;

  return (
    <div className="flex h-full bg-[#1e1c18]">
      {openPanes.map((sessionId, idx) => (
        <div key={sessionId} className="flex flex-1 min-w-0 h-full">
          {idx > 0 && (
            <div className="flex-[0_0_1px] bg-[#3e3830]" />
          )}
          <TerminalPane sessionId={sessionId} />
        </div>
      ))}
    </div>
  );
}

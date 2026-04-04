import { useRef, lazy, Suspense, useEffect } from 'react';
import { X, GitBranch, Terminal } from 'lucide-react';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';
import { defineAgentPlexTheme } from '../monaco-theme';

// Lazy-load GitDiffPanel so Monaco is only loaded when needed
const GitDiffPanel = lazy(() =>
  import('./GitDiffPanel').then((m) => ({ default: m.GitDiffPanel }))
);

// Initialize Monaco theme once
let themeInitialized = false;

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const sessionTitle = useAppStore(
    (s) => selectedSessionId
      ? s.displayNames[selectedSessionId] || s.sessions[selectedSessionId]?.title
      : null
  );
  const selectSession = useAppStore((s) => s.selectSession);
  const terminalTab = useAppStore((s) => s.terminalTab);
  const setTerminalTab = useAppStore((s) => s.setTerminalTab);
  useTerminal(containerRef);

  // Initialize Monaco theme on first git tab open
  useEffect(() => {
    if (terminalTab === 'git' && !themeInitialized) {
      themeInitialized = true;
      defineAgentPlexTheme();
    }
  }, [terminalTab]);

  if (!selectedSessionId) return null;

  return (
    <div className="flex flex-col h-full bg-[#1e1c18]">
      {/* Header with tabs */}
      <div className="flex items-center justify-between py-0 px-1 bg-[#262420] border-b border-[#3e3830]">
        <div className="flex items-center gap-0.5">
          <button
            className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              terminalTab === 'session'
                ? 'text-[#ece4d8] border-[#d18a7a]'
                : 'text-[#9a8a70] border-transparent hover:text-[#ece4d8]'
            }`}
            onClick={() => setTerminalTab('session')}
          >
            <Terminal size={12} />
            Session
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
        <div className="flex items-center gap-2 pr-1">
          <button
            className="bg-transparent border-none text-[#9a8a70] text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-[#3e3830] hover:text-[#ece4d8]"
            onClick={() => selectSession(null)}
            title="Close terminal"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Terminal body - always mounted, hidden when git tab active */}
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
            <GitDiffPanel sessionId={selectedSessionId} />
          </Suspense>
        </div>
      )}
    </div>
  );
}

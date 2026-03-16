import { useRef } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { useAppStore } from '../store';

export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const sessionTitle = useAppStore(
    (s) => selectedSessionId
      ? s.displayNames[selectedSessionId] || s.sessions[selectedSessionId]?.title
      : null
  );
  const selectSession = useAppStore((s) => s.selectSession);
  useTerminal(containerRef);

  if (!selectedSessionId) return null;

  return (
    <div className="terminal-panel">
      <div className="terminal-panel__header">
        <span className="terminal-panel__title">
          {sessionTitle || 'Terminal'}
        </span>
        <button
          className="terminal-panel__close"
          onClick={() => selectSession(null)}
          title="Close terminal"
        >
          ×
        </button>
      </div>
      <div className="terminal-panel__body" ref={containerRef} />
    </div>
  );
}

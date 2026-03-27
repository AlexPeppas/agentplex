import { useRef } from 'react';
import { X } from 'lucide-react';
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
    <div className="flex flex-col h-full bg-surface">
      <div className="flex items-center justify-between py-1.5 px-3 bg-inset border-b border-border">
        <span className="text-xs font-medium text-fg-muted">
          {sessionTitle || 'Terminal'}
        </span>
        <button
          className="bg-transparent border-none text-fg-muted text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-border hover:text-fg"
          onClick={() => selectSession(null)}
          title="Close terminal"
        >
          <X size={14} />
        </button>
      </div>
      <div className="terminal-body flex-1 p-1 overflow-hidden" ref={containerRef} />
    </div>
  );
}

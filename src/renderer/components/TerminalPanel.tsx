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
    <div className="flex flex-col h-full bg-[#1e1c18]">
      <div className="flex items-center justify-between py-1.5 px-3 bg-[#262420] border-b border-[#3e3830]">
        <span className="text-xs font-medium text-[#9a8a70]">
          {sessionTitle || 'Terminal'}
        </span>
        <button
          className="bg-transparent border-none text-[#9a8a70] text-base cursor-pointer py-0.5 px-1.5 rounded hover:bg-[#3e3830] hover:text-[#ece4d8]"
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

import { useEffect, useState, useCallback } from 'react';
import { useStore, bootstrap } from './store';
import PairingScreen from './components/PairingScreen';
import GraphCanvas from './components/GraphCanvas';
import Terminal from './components/Terminal';

// ── Icons ──────────────────────────────────────────────────────────────────

function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
      <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="10" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="10" width="5" height="5" rx="1" /><rect x="10" y="10" width="5" height="5" rx="1" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6.5" cy="6.5" r="4.5" /><path d="m11 11 3 3" strokeLinecap="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M1 4a1 1 0 0 1 1-1h4l2 2h6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" strokeLinecap="round" />
    </svg>
  );
}

// ── Connection badge ────────────────────────────────────────────────────────

function ConnectionDot() {
  const relayState = useStore(s => s.relayState);
  const machineOnline = useStore(s => s.machineOnline);
  const relayError = useStore(s => s.relayError);

  if (relayError) return <span className="w-2 h-2 rounded-full bg-red-500" title={relayError} />;
  if (relayState === 'connected' && machineOnline) return <span className="w-2 h-2 rounded-full bg-emerald-400" title="Live" />;
  if (relayState === 'connecting') return <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" title="Connecting" />;
  return <span className="w-2 h-2 rounded-full bg-[#4a4038]" title="Disconnected" />;
}

// ── Canvas empty state overlay ──────────────────────────────────────────────

function CanvasEmptyState() {
  const relayState = useStore(s => s.relayState);
  const machineOnline = useStore(s => s.machineOnline);
  const relayError = useStore(s => s.relayError);

  let msg = '';
  if (relayError) msg = relayError;
  else if (relayState === 'connecting') msg = 'Connecting to relay…';
  else if (relayState !== 'connected') msg = 'Disconnected';
  else if (!machineOnline) msg = 'Machine offline';

  if (!msg) return null;

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div className="flex items-center gap-2 bg-[#1e1c18]/80 px-4 py-2 rounded-lg border border-[#2a2420]">
        <ConnectionDot />
        <span className="text-sm text-[#6a6050]">{msg}</span>
      </div>
    </div>
  );
}

// ── Main app ────────────────────────────────────────────────────────────────

export default function App() {
  const machine = useStore(s => s.machine);
  const machineOnline = useStore(s => s.machineOnline);
  const sendCommand = useStore(s => s.sendCommand);
  const unpair = useStore(s => s.unpair);
  const sessions = useStore(s => s.sessions).filter(s => s.status !== 'killed');

  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'canvas' | 'terminal'>('canvas');

  // request buffer when switching to terminal
  const handleSelectSession = useCallback((id: string) => {
    useStore.getState().setActiveSession(id);
    setActiveSessionId(id);
    setActiveTab('terminal');
  }, []);

  const handleBackToCanvas = useCallback(() => {
    setActiveTab('canvas');
  }, []);

  useEffect(() => { bootstrap(); }, []);

  if (!machine) return <PairingScreen />;

  return (
    <div className="flex h-full bg-[#1a1814] overflow-hidden">

      {/* Left icon strip */}
      <div className="w-10 flex-shrink-0 flex flex-col items-center py-2 gap-1 border-r border-[#232120] bg-[#181614]">
        <button
          onClick={handleBackToCanvas}
          className={`w-8 h-8 flex items-center justify-center rounded transition-colors
            ${activeTab === 'canvas' ? 'text-[#c4a882]' : 'text-[#4a4038] hover:text-[#8a7060]'}`}
          title="Sessions"
        >
          <GridIcon />
        </button>
        <button className="w-8 h-8 flex items-center justify-center rounded text-[#4a4038] hover:text-[#8a7060] transition-colors" title="Search">
          <SearchIcon />
        </button>
        <button className="w-8 h-8 flex items-center justify-center rounded text-[#4a4038] hover:text-[#8a7060] transition-colors" title="Projects">
          <FolderIcon />
        </button>
        <div className="flex-1" />
        <button onClick={unpair} className="w-8 h-8 flex items-center justify-center rounded text-[#4a4038] hover:text-[#8a7060] transition-colors" title="Settings / Unpair">
          <SettingsIcon />
        </button>
      </div>

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Toolbar */}
        <div className="h-10 flex items-center px-4 gap-4 border-b border-[#232120] bg-[#1a1814] flex-shrink-0">
          <span className="text-sm font-semibold text-[#ece4d8] tracking-wide">AgentPlex</span>
          <div className="flex-1" />

          {activeTab === 'terminal' && activeSessionId && (
            <button
              onClick={handleBackToCanvas}
              className="text-xs text-[#6a6050] hover:text-[#ece4d8] px-2 py-1 rounded hover:bg-[#2a2420] transition-colors"
            >
              ← Canvas
            </button>
          )}

          <div className="flex items-center gap-2">
            <ConnectionDot />
            <span className="text-xs text-[#4a4038]">
              {sessions.length > 0 ? `${sessions.length} session${sessions.length > 1 ? 's' : ''}` : ''}
            </span>
          </div>

          <button
            onClick={() => sendCommand({ type: 'session:create', cli: 'claude' })}
            disabled={!machineOnline}
            className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium
              bg-[#c4874a]/20 text-[#c4874a] border border-[#c4874a]/30
              hover:bg-[#c4874a]/30 transition-colors
              disabled:opacity-30 disabled:pointer-events-none"
          >
            <span className="text-base leading-none">+</span>
            New Session
          </button>
        </div>

        {/* Canvas or Terminal */}
        <div className="flex-1 relative min-h-0">
          {activeTab === 'canvas' ? (
            <>
              <GraphCanvas onSelectSession={handleSelectSession} />
              <CanvasEmptyState />
            </>
          ) : activeSessionId ? (
            <Terminal key={activeSessionId} sessionId={activeSessionId} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

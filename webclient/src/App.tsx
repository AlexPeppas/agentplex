import { useEffect, useState, useCallback, useMemo } from 'react';
import { useStore, bootstrap } from './store';
import PairingScreen from './components/PairingScreen';
import GraphCanvas from './components/GraphCanvas';
import Terminal from './components/Terminal';
import SessionList from './components/SessionList';
import type { MachineStatus } from './relay/types';

// ── Icons ──────────────────────────────────────────────────────────────────

function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="currentColor">
      <rect x="1" y="1" width="5" height="5" rx="1" /><rect x="10" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="10" width="5" height="5" rx="1" /><rect x="10" y="10" width="5" height="5" rx="1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}

// ── Aggregate connection state across all machines ──────────────────────────

type Agg = { dot: string; title: string };

function aggregate(status: Record<string, MachineStatus>): Agg {
  const all = Object.values(status);
  if (all.length === 0) return { dot: 'bg-[#4a4038]', title: 'No machines' };
  const live = all.filter(s => s.relayState === 'connected' && s.online).length;
  const connecting = all.some(s => s.relayState === 'connecting');
  const anyError = all.some(s => s.error);
  if (live > 0) return { dot: 'bg-emerald-400', title: `${live} machine${live === 1 ? '' : 's'} live` };
  if (connecting) return { dot: 'bg-amber-400 animate-pulse', title: 'Connecting…' };
  if (anyError) return { dot: 'bg-red-500', title: 'Connection error' };
  return { dot: 'bg-[#4a4038]', title: 'All machines offline' };
}

function ConnectionDot() {
  const status = useStore(s => s.status);
  const agg = useMemo(() => aggregate(status), [status]);
  return <span className={`w-2 h-2 rounded-full ${agg.dot}`} title={agg.title} />;
}

// ── Main app ────────────────────────────────────────────────────────────────

export default function App() {
  const machines = useStore(s => s.machines);
  const active = useStore(s => s.active);
  const setActiveSession = useStore(s => s.setActiveSession);
  const clearActiveSession = useStore(s => s.clearActiveSession);

  const [activeTab, setActiveTab] = useState<'canvas' | 'terminal'>('canvas');
  const [showAddMachine, setShowAddMachine] = useState(false);

  const handleSelectSession = useCallback((machineId: string, sessionId: string) => {
    setActiveSession(machineId, sessionId);
    setActiveTab('terminal');
  }, [setActiveSession]);

  const handleBackToCanvas = useCallback(() => {
    clearActiveSession();
    setActiveTab('canvas');
  }, [clearActiveSession]);

  useEffect(() => { bootstrap(); }, []);

  // No machines paired yet → first-run pairing.
  if (machines.length === 0) return <PairingScreen />;

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
        <button
          onClick={() => setShowAddMachine(true)}
          className="w-8 h-8 flex items-center justify-center rounded text-[#4a4038] hover:text-[#8a7060] transition-colors"
          title="Add machine"
        >
          <PlusIcon />
        </button>
        <div className="flex-1" />
      </div>

      {/* Machines + sessions sidebar */}
      <SessionList
        active={active}
        onSelectSession={handleSelectSession}
        onAddMachine={() => setShowAddMachine(true)}
      />

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Toolbar */}
        <div className="h-10 flex items-center px-4 gap-4 border-b border-[#232120] bg-[#1a1814] flex-shrink-0">
          <span className="text-sm font-semibold text-[#ece4d8] tracking-wide">
            {activeTab === 'terminal' && active
              ? machines.find(m => m.machineId === active.machineId)?.name ?? 'Session'
              : 'All machines'}
          </span>
          <div className="flex-1" />

          {activeTab === 'terminal' && active && (
            <button
              onClick={handleBackToCanvas}
              className="text-xs text-[#6a6050] hover:text-[#ece4d8] px-2 py-1 rounded hover:bg-[#2a2420] transition-colors"
            >
              ← Canvas
            </button>
          )}

          <ConnectionDot />
        </div>

        {/* Canvas or Terminal */}
        <div className="flex-1 relative min-h-0">
          {activeTab === 'canvas' ? (
            <GraphCanvas onSelectSession={handleSelectSession} />
          ) : active ? (
            <Terminal
              key={`${active.machineId}:${active.sessionId}`}
              machineId={active.machineId}
              sessionId={active.sessionId}
            />
          ) : null}
        </div>
      </div>

      {/* Add-machine overlay */}
      {showAddMachine && (
        <PairingScreen
          overlay
          onDone={() => setShowAddMachine(false)}
          onCancel={() => setShowAddMachine(false)}
        />
      )}
    </div>
  );
}

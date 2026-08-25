import { useEffect, useState, useCallback, useMemo } from 'react';
import { LayoutGrid, Plus, Wifi, WifiOff } from 'lucide-react';
import { useStore, bootstrap } from './store';
import PairingScreen from './components/PairingScreen';
import GraphCanvas from './components/GraphCanvas';
import Terminal from './components/Terminal';
import SessionList from './components/SessionList';
import logo from './assets/logo.svg';
import type { MachineStatus } from './relay/types';

// ── Aggregate connection state across all machines ──────────────────────────

function aggregate(status: Record<string, MachineStatus>): { color: string; title: string; live: boolean } {
  const all = Object.values(status);
  if (all.length === 0) return { color: 'var(--text-muted)', title: 'No machines', live: false };
  const live = all.filter(s => s.relayState === 'connected' && s.online).length;
  const connecting = all.some(s => s.relayState === 'connecting');
  const anyError = all.some(s => s.error);
  if (live > 0) return { color: 'var(--success)', title: `${live} machine${live === 1 ? '' : 's'} live`, live: true };
  if (connecting) return { color: 'var(--warning)', title: 'Connecting…', live: false };
  if (anyError) return { color: 'var(--error)', title: 'Connection error', live: false };
  return { color: 'var(--text-muted)', title: 'All machines offline', live: false };
}

function ConnectionBadge() {
  const status = useStore(s => s.status);
  const agg = useMemo(() => aggregate(status), [status]);
  const Icon = agg.live ? Wifi : WifiOff;
  return (
    <span className="flex items-center gap-1.5" title={agg.title}>
      <Icon size={13} style={{ color: agg.color }} />
      <span className="text-[11px]" style={{ color: agg.color }}>{agg.title}</span>
    </span>
  );
}

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

  if (machines.length === 0) return <PairingScreen />;

  const activeMachineName = active ? machines.find(m => m.machineId === active.machineId)?.name : null;

  return (
    <div className="flex h-full bg-surface overflow-hidden">

      {/* Activity bar (left icon strip) */}
      <div className="w-11 flex-shrink-0 flex flex-col items-center py-2.5 gap-1 border-r border-border bg-inset">
        <img src={logo} alt="AgentPlex" className="w-6 h-6 mb-2" />
        <button
          onClick={handleBackToCanvas}
          className={`w-9 h-9 flex items-center justify-center rounded-md transition-colors
            ${activeTab === 'canvas' ? 'bg-accent-subtle text-accent' : 'text-fg-muted hover:text-fg hover:bg-elevated'}`}
          title="Sessions"
        >
          <LayoutGrid size={18} />
        </button>
        <button
          onClick={() => setShowAddMachine(true)}
          className="w-9 h-9 flex items-center justify-center rounded-md text-fg-muted hover:text-fg hover:bg-elevated transition-colors"
          title="Add machine"
        >
          <Plus size={18} />
        </button>
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
        <div className="h-10 flex items-center px-4 gap-4 border-b border-border bg-surface flex-shrink-0">
          <span className="text-[13px] font-semibold text-fg tracking-wide">
            {activeTab === 'terminal' && activeMachineName ? activeMachineName : 'All machines'}
          </span>
          <div className="flex-1" />

          {activeTab === 'terminal' && active && (
            <button
              onClick={handleBackToCanvas}
              className="text-[11px] text-fg-muted hover:text-fg px-2 py-1 rounded hover:bg-elevated transition-colors"
            >
              ← Canvas
            </button>
          )}

          <ConnectionBadge />
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

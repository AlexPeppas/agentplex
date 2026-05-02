import { useStore } from '../store';
import type { SessionInfo } from '../relay/types';

const STATUS_DOT: Record<string, string> = {
  running:             'bg-emerald-400',
  idle:                'bg-[#4a4038]',
  'waiting-for-input': 'bg-amber-400 animate-pulse',
  killed:              'bg-red-500',
};

const STATUS_LABEL: Record<string, string> = {
  running:             'running',
  idle:                'idle',
  'waiting-for-input': 'waiting',
  killed:              'killed',
};

function SessionCard({ session, active, onClick }: {
  session: SessionInfo;
  active: boolean;
  onClick: () => void;
}) {
  const displayNames = useStore(s => s.displayNames);
  const label = displayNames[session.id] ?? session.title;
  const dir = session.cwd.replace(/\\/g, '/').split('/').pop() ?? session.cwd;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded transition-all duration-100 group
        ${active
          ? 'bg-[#3a3428] ring-1 ring-[#5a5040]'
          : 'hover:bg-[#252320]'
        }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-0.5 ${STATUS_DOT[session.status] ?? 'bg-[#4a4038]'}`} />
        <span className={`text-sm truncate flex-1 ${active ? 'text-[#ece4d8]' : 'text-[#a09070] group-hover:text-[#cdc4b4]'}`}>
          {label}
        </span>
        <span className={`text-[10px] uppercase tracking-wider flex-shrink-0 ${active ? 'text-[#6a5f4a]' : 'text-[#3a3428]'}`}>
          {STATUS_LABEL[session.status] ?? session.status}
        </span>
      </div>
      <div className={`text-[11px] ml-3.5 truncate mt-0.5 ${active ? 'text-[#5a5040]' : 'text-[#3a3028]'}`}>
        {dir} · {session.cli}
      </div>
    </button>
  );
}

function ConnectionBadge() {
  const relayState = useStore(s => s.relayState);
  const machineOnline = useStore(s => s.machineOnline);
  const relayError = useStore(s => s.relayError);

  if (relayError) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
        <span className="text-[10px] text-red-400 truncate" title={relayError}>error</span>
      </div>
    );
  }

  const label = relayState === 'connected'
    ? machineOnline ? 'live' : 'machine offline'
    : relayState === 'connecting' ? 'connecting…' : 'disconnected';

  const dotClass = relayState === 'connected' && machineOnline
    ? 'bg-emerald-400'
    : relayState === 'connecting'
    ? 'bg-amber-400 animate-pulse'
    : 'bg-[#4a4038]';

  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      <span className="text-[10px] text-[#5a5040]">{label}</span>
    </div>
  );
}

export default function SessionList() {
  const sessions = useStore(s => s.sessions);
  const activeSessionId = useStore(s => s.activeSessionId);
  const setActiveSession = useStore(s => s.setActiveSession);
  const machineOnline = useStore(s => s.machineOnline);
  const sendCommand = useStore(s => s.sendCommand);
  const machine = useStore(s => s.machine);
  const unpair = useStore(s => s.unpair);

  const alive = sessions.filter(s => s.status !== 'killed');
  const running = alive.filter(s => s.status === 'running').length;

  return (
    <div className="w-52 flex-shrink-0 flex flex-col h-full bg-[#1a1814] border-r border-[#2a2420]">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#2a2420]">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] font-semibold text-[#ece4d8] tracking-wider uppercase">AgentPlex</span>
          <ConnectionBadge />
        </div>
        {machine && (
          <div className="text-[10px] text-[#3a3028] font-mono truncate" title={machine.machineId}>
            {machine.machineId.slice(8, 24)}…
          </div>
        )}
      </div>

      {/* Section label */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[10px] text-[#4a4038] uppercase tracking-wider">Sessions</span>
        {running > 0 && (
          <span className="text-[10px] text-emerald-500">{running} running</span>
        )}
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-1.5 pb-2 space-y-0.5">
        {alive.length === 0 ? (
          <div className="px-3 py-2 text-[11px] text-[#3a3028]">
            {machineOnline ? 'No sessions running' : 'Machine offline'}
          </div>
        ) : (
          alive.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              active={s.id === activeSessionId}
              onClick={() => setActiveSession(s.id)}
            />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a2420] px-1.5 py-2 space-y-0.5">
        <button
          onClick={() => sendCommand({ type: 'session:create', cli: 'claude' })}
          disabled={!machineOnline}
          className="w-full text-left px-3 py-1.5 rounded text-[11px] text-[#6a5f4a] hover:text-[#ece4d8] hover:bg-[#252320] transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          + New Claude session
        </button>
        <button
          onClick={() => sendCommand({ type: 'session:list' })}
          disabled={!machineOnline}
          className="w-full text-left px-3 py-1.5 rounded text-[11px] text-[#6a5f4a] hover:text-[#ece4d8] hover:bg-[#252320] transition-colors disabled:opacity-30 disabled:pointer-events-none"
        >
          ↺  Refresh sessions
        </button>
        <button
          onClick={unpair}
          className="w-full text-left px-3 py-1.5 rounded text-[11px] text-[#3a3028] hover:text-red-400 hover:bg-[#252320] transition-colors"
        >
          ⊘  Unpair device
        </button>
      </div>
    </div>
  );
}

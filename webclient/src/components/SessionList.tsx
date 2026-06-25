import { useStore } from '../store';
import type { SessionInfo, MachineStatus } from '../relay/types';

const STATUS_DOT: Record<string, string> = {
  running:             'bg-emerald-400',
  idle:                'bg-[#4a4038]',
  'waiting-for-input': 'bg-amber-400 animate-pulse',
  killed:              'bg-red-500',
};

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };

function machineDot(status: MachineStatus): { cls: string; label: string } {
  if (status.error) return { cls: 'bg-red-500', label: 'error' };
  if (status.relayState === 'connected' && status.online) return { cls: 'bg-emerald-400', label: 'live' };
  if (status.relayState === 'connected') return { cls: 'bg-[#4a4038]', label: 'offline' };
  if (status.relayState === 'connecting') return { cls: 'bg-amber-400 animate-pulse', label: 'connecting' };
  return { cls: 'bg-[#4a4038]', label: 'disconnected' };
}

function SessionRow({ session, active, onClick }: {
  session: SessionInfo;
  active: boolean;
  onClick: () => void;
}) {
  const displayNames = useStore(s => s.displayNames);
  const label = displayNames[session.machineId]?.[session.id] ?? session.title;
  const dir = session.cwd.replace(/\\/g, '/').split('/').pop() ?? session.cwd;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left pl-5 pr-3 py-1.5 rounded transition-all duration-100 group
        ${active ? 'bg-[#3a3428] ring-1 ring-[#5a5040]' : 'hover:bg-[#252320]'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[session.status] ?? 'bg-[#4a4038]'}`} />
        <span className={`text-sm truncate flex-1 ${active ? 'text-[#ece4d8]' : 'text-[#a09070] group-hover:text-[#cdc4b4]'}`}>
          {label}
        </span>
      </div>
      <div className={`text-[11px] ml-3.5 truncate mt-0.5 ${active ? 'text-[#5a5040]' : 'text-[#3a3028]'}`}>
        {dir} · {session.cli}
      </div>
    </button>
  );
}

interface Props {
  active: { machineId: string; sessionId: string } | null;
  onSelectSession: (machineId: string, sessionId: string) => void;
  onAddMachine: () => void;
}

export default function SessionList({ active, onSelectSession, onAddMachine }: Props) {
  const machines = useStore(s => s.machines);
  const sessions = useStore(s => s.sessions);
  const status = useStore(s => s.status);
  const sendCommand = useStore(s => s.sendCommand);
  const removeMachine = useStore(s => s.removeMachine);

  return (
    <div className="w-60 flex-shrink-0 flex flex-col h-full bg-[#1a1814] border-r border-[#2a2420]">
      {/* Header */}
      <div className="px-3 py-3 border-b border-[#2a2420] flex items-center justify-between">
        <span className="text-[11px] font-semibold text-[#ece4d8] tracking-wider uppercase">AgentPlex</span>
        <span className="text-[10px] text-[#5a5040]">{machines.length} machine{machines.length === 1 ? '' : 's'}</span>
      </div>

      {/* Machines + sessions */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {machines.map(machine => {
          const mid = machine.machineId;
          const st = status[mid] ?? DISCONNECTED;
          const dot = machineDot(st);
          const online = st.relayState === 'connected' && st.online;
          const mSessions = sessions.filter(s => s.machineId === mid && s.status !== 'killed');

          return (
            <div key={mid} className="mb-1">
              {/* Machine header */}
              <div className="flex items-center gap-2 px-3 py-1.5 group">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot.cls}`} title={dot.label} />
                <span className="text-xs font-semibold text-[#ddd4c4] truncate flex-1" title={mid}>{machine.name}</span>
                <button
                  onClick={() => sendCommand(mid, { type: 'session:create', cli: 'claude' })}
                  disabled={!online}
                  title="New Claude session"
                  className="text-[11px] text-[#6a5f4a] hover:text-[#c4874a] disabled:opacity-30 disabled:pointer-events-none px-1"
                >
                  +
                </button>
                <button
                  onClick={() => { if (confirm(`Unpair "${machine.name}"? This revokes this browser's access.`)) removeMachine(mid); }}
                  title="Unpair machine"
                  className="text-[11px] text-[#3a3028] hover:text-red-400 px-1 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ⊘
                </button>
              </div>

              {/* Sessions for this machine */}
              <div className="px-1.5 space-y-0.5">
                {mSessions.length === 0 ? (
                  <div className="pl-5 pr-3 py-1 text-[11px] text-[#3a3028]">
                    {online ? 'No sessions' : dot.label}
                  </div>
                ) : (
                  mSessions.map(s => (
                    <SessionRow
                      key={`${mid}:${s.id}`}
                      session={s}
                      active={active?.machineId === mid && active?.sessionId === s.id}
                      onClick={() => onSelectSession(mid, s.id)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-[#2a2420] px-1.5 py-2">
        <button
          onClick={onAddMachine}
          className="w-full text-left px-3 py-1.5 rounded text-[11px] text-[#6a5f4a] hover:text-[#ece4d8] hover:bg-[#252320] transition-colors"
        >
          +  Add machine
        </button>
      </div>
    </div>
  );
}

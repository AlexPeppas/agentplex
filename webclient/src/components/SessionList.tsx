import { Plus, Monitor, Unplug } from 'lucide-react';
import { useStore } from '../store';
import type { SessionInfo, MachineStatus, SessionStatus } from '../relay/types';
import { CliIcon } from './CliIcon';

const STATUS_VAR: Record<SessionStatus, string> = {
  running: 'var(--success)',
  idle: 'var(--text-muted)',
  'waiting-for-input': 'var(--warning)',
  killed: 'var(--error)',
};

const DISCONNECTED: MachineStatus = { relayState: 'disconnected', online: false, error: null };

function machineDot(status: MachineStatus): { color: string; label: string } {
  if (status.error) return { color: 'var(--error)', label: 'error' };
  if (status.relayState === 'connected' && status.online) return { color: 'var(--success)', label: 'live' };
  if (status.relayState === 'connected') return { color: 'var(--text-muted)', label: 'offline' };
  if (status.relayState === 'connecting') return { color: 'var(--warning)', label: 'connecting' };
  return { color: 'var(--text-muted)', label: 'disconnected' };
}

function SessionRow({ session, active, onClick, mobile }: {
  session: SessionInfo;
  active: boolean;
  onClick: () => void;
  mobile: boolean;
}) {
  const displayNames = useStore(s => s.displayNames);
  const label = displayNames[session.machineId]?.[session.id] ?? session.title;
  const dir = session.cwd.replace(/\\/g, '/').split('/').pop() ?? session.cwd;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left pl-6 pr-3 ${mobile ? 'py-3' : 'py-1.5'} rounded-md transition-colors group
        ${active ? 'bg-accent-subtle' : 'hover:bg-elevated'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: STATUS_VAR[session.status] }} />
        <CliIcon cli={session.cli} size={11} />
        <span className={`${mobile ? 'text-[15px]' : 'text-[13px]'} truncate flex-1 ${active ? 'text-fg' : 'text-fg-muted group-hover:text-fg'}`}>
          {label}
        </span>
      </div>
      <div className="text-[11px] ml-4 truncate mt-0.5 text-fg-muted/70">{dir}</div>
    </button>
  );
}

interface Props {
  active: { machineId: string; sessionId: string } | null;
  onSelectSession: (machineId: string, sessionId: string) => void;
  onAddMachine: () => void;
  mobile?: boolean;
}

export default function SessionList({ active, onSelectSession, onAddMachine, mobile = false }: Props) {
  const machines = useStore(s => s.machines);
  const sessions = useStore(s => s.sessions);
  const status = useStore(s => s.status);
  const sendCommand = useStore(s => s.sendCommand);
  const removeMachine = useStore(s => s.removeMachine);

  return (
    <div className={`${mobile ? 'w-full' : 'w-60 border-r'} flex-shrink-0 flex flex-col h-full bg-inset border-border`}>
      {/* Header */}
      <div className="px-3 py-3 border-b border-border flex items-center justify-between">
        <div>
          <span className="text-[11px] font-semibold text-fg tracking-wider uppercase">AgentPlex</span>
          {mobile && <div className="text-[12px] text-fg-muted mt-0.5">Remote sessions</div>}
        </div>
        <span className="text-[10px] text-fg-muted">{machines.length} machine{machines.length === 1 ? '' : 's'}</span>
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
            <div key={mid} className="mb-1.5">
              {/* Machine header */}
              <div className={`flex items-center gap-2 px-3 group ${mobile ? 'py-3' : 'py-1.5'}`}>
                <Monitor size={mobile ? 16 : 13} className="text-fg-muted shrink-0" />
                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: dot.color }} title={dot.label} />
                <span className={`${mobile ? 'text-[14px]' : 'text-[12px]'} font-semibold text-fg truncate flex-1`} title={mid}>{machine.name}</span>
                <button
                  onClick={() => sendCommand(mid, { type: 'session:create', cli: 'claude' })}
                  disabled={!online}
                  title="New Claude session"
                  className="text-fg-muted hover:text-accent disabled:opacity-30 disabled:pointer-events-none"
                >
                  <Plus size={13} />
                </button>
                <button
                  onClick={() => { if (confirm(`Unpair "${machine.name}"? This revokes this browser's access.`)) removeMachine(mid); }}
                  title="Unpair machine"
                  className="text-fg-muted hover:text-error opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Unplug size={13} />
                </button>
              </div>

              {/* Sessions for this machine */}
              <div className="px-1.5 space-y-0.5">
                {mSessions.length === 0 ? (
                  <div className="pl-6 pr-3 py-1 text-[11px] text-fg-muted/60">
                    {online ? 'No sessions' : dot.label}
                  </div>
                ) : (
                  mSessions.map(s => (
                    <SessionRow
                      key={`${mid}:${s.id}`}
                      session={s}
                      active={active?.machineId === mid && active?.sessionId === s.id}
                      onClick={() => onSelectSession(mid, s.id)}
                      mobile={mobile}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-border px-1.5 py-2">
        <button
          onClick={onAddMachine}
          className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[12px] text-fg-muted hover:text-fg hover:bg-elevated transition-colors"
        >
          <Plus size={13} /> Add machine
        </button>
      </div>
    </div>
  );
}

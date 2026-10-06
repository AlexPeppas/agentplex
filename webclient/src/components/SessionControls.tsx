import { useState } from 'react';
import { useStore } from '../store';

export default function SessionControls({ machineId, sessionId }: { machineId: string; sessionId: string }) {
  const session = useStore(s => s.sessions.find(session => session.machineId === machineId && session.id === sessionId));
  const name = useStore(s => s.displayNames[machineId]?.[sessionId]) ?? session?.title ?? sessionId;
  const ready = useStore(s => Boolean(s.status[machineId]?.ready));
  const error = useStore(s => s.status[machineId]?.error);
  const execute = useStore(s => s.executeCommand);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState('');

  async function act(type: 'session:rename' | 'session:kill') {
    const nextName = type === 'session:rename' ? window.prompt('Session name', name) : null;
    if (type === 'session:rename' && !nextName?.trim()) return;
    if (type === 'session:kill' && !window.confirm(`Stop "${name}" on its local machine? This terminates its CLI process.`)) return;
    setBusy(true);
    setLocalError('');
    try {
      await execute(machineId, type === 'session:rename'
        ? { type, id: sessionId, name: nextName?.trim() ?? '' }
        : { type, id: sessionId });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-border p-2 text-xs space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex-1 truncate" title={session?.cwd}>{name}</span>
        <span className="text-fg-muted">{ready ? session?.status : 'Offline / reconnecting'}</span>
        <button disabled={!ready || busy} onClick={() => void act('session:rename')} className="p-2 rounded hover:bg-elevated disabled:opacity-40">Rename</button>
        <button disabled={!ready || busy || session?.status === 'killed'} onClick={() => void act('session:kill')} className="p-2 rounded text-error hover:bg-elevated disabled:opacity-40">Stop</button>
      </div>
      {(localError || error) && <p role="alert" className="text-error break-words">{localError || error}</p>}
      {!ready && <p className="text-fg-muted">Cached terminal view. Input is disabled until this machine reconnects.</p>}
    </div>
  );
}

import { useRef, useState } from 'react';
import { useStore } from '../store';

export default function NewSessionForm({ machineId, onDone, onCancel }: {
  machineId: string;
  onDone: (sessionId: string) => void;
  onCancel: () => void;
}) {
  const capabilities = useStore(s => s.capabilities[machineId]);
  const sessions = useStore(s => s.sessions);
  const ready = useStore(s => Boolean(s.status[machineId]?.ready));
  const execute = useStore(s => s.executeCommand);
  const [cwd, setCwd] = useState(capabilities?.home ?? '');
  const [cli, setCli] = useState('claude');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const directories = [...new Set(sessions.filter(s => s.machineId === machineId).map(s => s.cwd))];

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await execute(machineId, { type: 'session:create', cli, cwd: cwd.trim() || undefined });
      if (!result.session) throw new Error('Machine returned no session');
      onDone(result.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form onSubmit={create} aria-label="New remote session" className="m-2 p-3 border border-border rounded space-y-2 text-xs">
      <label className="block">CLI or shell
        <select value={cli} onChange={e => setCli(e.target.value)} disabled={busy}
          className="w-full mt-1 p-2 rounded bg-elevated">
          {(capabilities?.clis ?? [{ id: 'claude', label: 'Claude' }, { id: 'copilot', label: 'GitHub Copilot' }, { id: 'codex', label: 'Codex' }])
            .map(tool => <option key={tool.id} value={tool.id}>{tool.label}</option>)}
        </select>
      </label>
      <label className="block">Directory on this machine
        <input value={cwd} onChange={e => setCwd(e.target.value)} disabled={busy} list={`dirs-${machineId}`}
          placeholder="Home directory" className="w-full mt-1 p-2 rounded bg-elevated" />
        <datalist id={`dirs-${machineId}`}>{directories.map(dir => <option key={dir} value={dir} />)}</datalist>
      </label>
      {error && <p role="alert" className="text-error break-words">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy || !ready} type="submit" className="p-2 rounded bg-accent text-surface disabled:opacity-40">
          {busy ? 'Creating...' : 'Create'}
        </button>
        <button disabled={busy} type="button" onClick={onCancel} className="p-2">Cancel</button>
      </div>
    </form>
  );
}

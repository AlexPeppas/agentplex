import { useState } from 'react';
import { X } from 'lucide-react';
import { RelayClient } from '../relay/client';
import { useStore } from '../store';
import logo from '../assets/logo.svg';

interface Props {
  /** When true the form renders as a dismissible overlay (adding another machine). */
  overlay?: boolean;
  onDone?: () => void;
  onCancel?: () => void;
}

export default function PairingScreen({ overlay = false, onDone, onCancel }: Props) {
  const addMachine = useStore(s => s.addMachine);
  const existing = useStore(s => s.machines);

  const [relayUrl, setRelayUrl] = useState(existing[0]?.relayUrl ?? 'http://localhost:8080');
  const [machineId, setMachineId] = useState('');
  const [machineLabel, setMachineLabel] = useState('');
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState('Web Browser');
  const [status, setStatus] = useState<'idle' | 'pairing' | 'error'>('idle');
  const [error, setError] = useState('');
  const normalizedCode = code.replace(/-/g, '');

  async function handlePair(e: React.FormEvent) {
    e.preventDefault();
    setStatus('pairing');
    setError('');
    try {
      const machine = await RelayClient.completePairing(
        relayUrl.replace(/\/$/, ''),
        machineId.trim(),
        code.trim(),
        deviceName.trim() || 'Web Browser',
        machineLabel.trim(),
      );
      await addMachine(machine);
      onDone?.();
    } catch (err: any) {
      setStatus('error');
      setError(err.message ?? 'Pairing failed');
    }
  }

  const inputCls = 'w-full px-3 py-2 bg-inset border border-border rounded-md text-fg text-sm outline-none focus:border-accent transition-colors';
  const labelCls = 'text-[11px] text-fg-muted uppercase tracking-wider';

  const form = (
    <div className="w-full max-w-md p-8 space-y-6">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <img src={logo} alt="AgentPlex" className="w-9 h-9" />
          <div className="space-y-0.5">
            <h1 className="text-2xl font-semibold text-fg tracking-tight">
              {overlay ? 'Pair another machine' : 'AgentPlex'}
            </h1>
            <p className="text-sm text-fg-muted">
              {overlay ? 'Add a devbox, laptop, or any machine running AgentPlex' : 'Connect to your machines via the relay'}
            </p>
          </div>
        </div>
        {overlay && (
          <button onClick={onCancel} className="text-fg-muted hover:text-fg p-1" title="Cancel">
            <X size={18} />
          </button>
        )}
      </div>

      <form onSubmit={handlePair} className="space-y-4">
        <div className="space-y-1.5">
          <label className={labelCls}>Relay URL</label>
          <input type="url" value={relayUrl} onChange={e => setRelayUrl(e.target.value)}
            placeholder="https://relay.agentplex.dev" required className={inputCls} />
        </div>

        <div className="space-y-1.5">
          <label className={labelCls}>Machine ID</label>
          <input type="text" value={machineId} onChange={e => setMachineId(e.target.value)}
            placeholder="machine-abc123…" required className={`${inputCls} font-mono`} />
          <p className="text-[11px] text-fg-muted/70">AgentPlex → Settings → Remote access → Machine ID</p>
        </div>

        <div className="space-y-1.5">
          <label className={labelCls}>Machine Name</label>
          <input type="text" value={machineLabel} onChange={e => setMachineLabel(e.target.value)}
            placeholder="Devbox / Laptop" className={inputCls} />
        </div>

        <div className="space-y-1.5">
          <label className={labelCls}>Pairing Code</label>
          <input type="text" value={code}
            onChange={e => setCode(e.target.value.replace(/[^0-9a-f-]/gi, '').slice(0, 39).toLowerCase())}
            placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx" maxLength={39} required
            className={`${inputCls} text-sm font-mono tracking-wider text-center`} />
          <p className="text-[11px] text-fg-muted/70">Generate in AgentPlex → Settings → Remote access → Generate code</p>
        </div>

        <div className="space-y-1.5">
          <label className={labelCls}>This Device Name</label>
          <input type="text" value={deviceName} onChange={e => setDeviceName(e.target.value)}
            placeholder="Web Browser" className={inputCls} />
        </div>

        {error && <p className="text-sm text-error bg-error-subtle px-3 py-2 rounded-md">{error}</p>}

        <button type="submit" disabled={status === 'pairing' || normalizedCode.length !== 32}
          className="w-full py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed text-surface text-sm font-semibold rounded-md transition-colors">
          {status === 'pairing' ? 'Pairing…' : overlay ? 'Add Machine' : 'Pair Device'}
        </button>
      </form>

      <p className="text-[11px] text-fg-muted/60 text-center">
        All traffic is end-to-end encrypted. The relay never sees your terminal data.
      </p>
    </div>
  );

  if (overlay) {
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--backdrop)' }}>
        <div className="bg-surface border border-border rounded-xl shadow-2xl">{form}</div>
      </div>
    );
  }

  return <div className="flex items-center justify-center h-full bg-surface">{form}</div>;
}

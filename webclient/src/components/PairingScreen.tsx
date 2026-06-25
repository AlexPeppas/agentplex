import { useState } from 'react';
import { RelayClient } from '../relay/client';
import { useStore } from '../store';

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

  const form = (
    <div className="w-full max-w-md p-8 space-y-6">
      {/* Logo / title */}
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold text-[#ece4d8] tracking-tight">
            {overlay ? 'Pair another machine' : 'AgentPlex'}
          </h1>
          <p className="text-sm text-[#8a8070]">
            {overlay ? 'Add a devbox, laptop, or any machine running AgentPlex' : 'Connect to your machines via the relay'}
          </p>
        </div>
        {overlay && (
          <button
            onClick={onCancel}
            className="text-[#6a6050] hover:text-[#ece4d8] text-lg leading-none px-2 py-1"
            title="Cancel"
          >
            ✕
          </button>
        )}
      </div>

      <form onSubmit={handlePair} className="space-y-4">
        {/* Relay URL */}
        <div className="space-y-1.5">
          <label className="text-xs text-[#8a8070] uppercase tracking-wider">Relay URL</label>
          <input
            type="url"
            value={relayUrl}
            onChange={e => setRelayUrl(e.target.value)}
            placeholder="https://relay.agentplex.dev"
            required
            className="w-full px-3 py-2 bg-[#262420] border border-[#3a3428] rounded text-[#ece4d8] text-sm outline-none focus:border-[#6a5f4a] transition-colors"
          />
        </div>

        {/* Machine ID */}
        <div className="space-y-1.5">
          <label className="text-xs text-[#8a8070] uppercase tracking-wider">Machine ID</label>
          <input
            type="text"
            value={machineId}
            onChange={e => setMachineId(e.target.value)}
            placeholder="machine-abc123..."
            required
            className="w-full px-3 py-2 bg-[#262420] border border-[#3a3428] rounded text-[#ece4d8] text-sm font-mono outline-none focus:border-[#6a5f4a] transition-colors"
          />
          <p className="text-xs text-[#5a5040]">Find this in AgentPlex → Settings → Remote → Machine ID</p>
        </div>

        {/* Machine label */}
        <div className="space-y-1.5">
          <label className="text-xs text-[#8a8070] uppercase tracking-wider">Machine Name</label>
          <input
            type="text"
            value={machineLabel}
            onChange={e => setMachineLabel(e.target.value)}
            placeholder="Devbox / Laptop"
            className="w-full px-3 py-2 bg-[#262420] border border-[#3a3428] rounded text-[#ece4d8] text-sm outline-none focus:border-[#6a5f4a] transition-colors"
          />
          <p className="text-xs text-[#5a5040]">A friendly label for this machine in the sidebar.</p>
        </div>

        {/* Pairing code */}
        <div className="space-y-1.5">
          <label className="text-xs text-[#8a8070] uppercase tracking-wider">Pairing Code</label>
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            maxLength={6}
            required
            className="w-full px-3 py-2 bg-[#262420] border border-[#3a3428] rounded text-[#ece4d8] text-2xl font-mono tracking-[0.5em] text-center outline-none focus:border-[#6a5f4a] transition-colors"
          />
          <p className="text-xs text-[#5a5040]">Generate in AgentPlex → Settings → Remote → Pair Device</p>
        </div>

        {/* Device name */}
        <div className="space-y-1.5">
          <label className="text-xs text-[#8a8070] uppercase tracking-wider">This Device Name</label>
          <input
            type="text"
            value={deviceName}
            onChange={e => setDeviceName(e.target.value)}
            placeholder="Web Browser"
            className="w-full px-3 py-2 bg-[#262420] border border-[#3a3428] rounded text-[#ece4d8] text-sm outline-none focus:border-[#6a5f4a] transition-colors"
          />
        </div>

        {error && (
          <p className="text-sm text-red-400 bg-red-900/20 px-3 py-2 rounded">{error}</p>
        )}

        <button
          type="submit"
          disabled={status === 'pairing' || code.length !== 6}
          className="w-full py-2.5 bg-[#6a5f4a] hover:bg-[#7a6f5a] disabled:opacity-40 disabled:cursor-not-allowed text-[#ece4d8] text-sm font-medium rounded transition-colors"
        >
          {status === 'pairing' ? 'Pairing...' : overlay ? 'Add Machine' : 'Pair Device'}
        </button>
      </form>

      <p className="text-xs text-[#3a3028] text-center">
        All traffic is end-to-end encrypted. The relay never sees your terminal data.
      </p>
    </div>
  );

  if (overlay) {
    return (
      <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-[#1a1814] border border-[#2a2420] rounded-xl shadow-2xl">
          {form}
        </div>
      </div>
    );
  }

  return <div className="flex items-center justify-center h-full bg-[#1a1814]">{form}</div>;
}

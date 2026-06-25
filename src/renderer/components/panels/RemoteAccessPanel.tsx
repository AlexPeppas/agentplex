import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, Trash2, Wifi, WifiOff, Loader2, Smartphone } from 'lucide-react';
import type { RemoteStatus, RemotePairedDevice, RelayConnState } from '../../../shared/ipc-channels';

function stateLabel(state: RelayConnState): { text: string; cls: string } {
  switch (state) {
    case 'connected':      return { text: 'Connected', cls: 'text-emerald-400' };
    case 'connecting':     return { text: 'Connecting…', cls: 'text-amber-400' };
    case 'authenticating': return { text: 'Authenticating…', cls: 'text-amber-400' };
    default:               return { text: 'Disconnected', cls: 'text-fg-muted' };
  }
}

export function RemoteAccessPanel() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState('');
  const [devices, setDevices] = useState<RemotePairedDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const [pairCode, setPairCode] = useState<string | null>(null);
  const [pairSecondsLeft, setPairSecondsLeft] = useState(0);
  const pairTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await window.agentPlex.remoteListDevices()); } catch { /* ignore */ }
  }, []);

  // Initial load + live subscriptions.
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const s = await window.agentPlex.remoteGetStatus();
        if (!mounted) return;
        setStatus(s);
        setRelayUrl(s.relayUrl || 'http://localhost:8080');
      } catch { /* ignore */ }
      await refreshDevices();
    })();

    const offState = window.agentPlex.onRemoteStateChanged(({ relayState }) => {
      setStatus(prev => (prev ? { ...prev, relayState } : prev));
    });
    const offDevices = window.agentPlex.onRemoteDevicesChanged(() => { void refreshDevices(); });

    return () => {
      mounted = false;
      offState();
      offDevices();
      if (pairTimerRef.current) clearInterval(pairTimerRef.current);
    };
  }, [refreshDevices]);

  const connected = status?.relayState === 'connected';
  const transitioning = status?.relayState === 'connecting' || status?.relayState === 'authenticating';

  const handleConnectToggle = useCallback(async () => {
    setError('');
    setBusy(true);
    try {
      const next = connected
        ? await window.agentPlex.remoteDisconnect()
        : await window.agentPlex.remoteConnect(relayUrl.trim());
      setStatus(next);
      if (connected) { setPairCode(null); }
    } catch (err: any) {
      setError(err?.message ?? 'Operation failed');
    } finally {
      setBusy(false);
    }
  }, [connected, relayUrl]);

  const handleCopyMachineId = useCallback(async () => {
    if (!status) return;
    try { window.agentPlex.clipboardWriteText(status.machineId); } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [status]);

  const handlePair = useCallback(async () => {
    setError('');
    try {
      const { code, expiresIn } = await window.agentPlex.remotePair();
      setPairCode(code);
      setPairSecondsLeft(expiresIn);
      if (pairTimerRef.current) clearInterval(pairTimerRef.current);
      pairTimerRef.current = setInterval(() => {
        setPairSecondsLeft(prev => {
          if (prev <= 1) {
            if (pairTimerRef.current) clearInterval(pairTimerRef.current);
            setPairCode(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } catch (err: any) {
      setError(err?.message ?? 'Pairing failed');
    }
  }, []);

  const handleRevoke = useCallback(async (deviceId: string) => {
    setError('');
    try { setDevices(await window.agentPlex.remoteRevokeDevice(deviceId)); }
    catch (err: any) { setError(err?.message ?? 'Revoke failed'); }
  }, []);

  const st = stateLabel(status?.relayState ?? 'disconnected');
  const mins = Math.floor(pairSecondsLeft / 60);
  const secs = (pairSecondsLeft % 60).toString().padStart(2, '0');

  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <div className="flex items-center gap-2 pt-1">
        {connected ? <Wifi size={13} className="text-emerald-400" /> : <WifiOff size={13} className="text-fg-muted" />}
        <span className="text-xs font-semibold text-fg">Remote access</span>
        <span className={`text-[10px] ml-auto ${st.cls}`}>{st.text}</span>
      </div>

      {/* Machine ID */}
      <div className="rounded-md bg-elevated px-2.5 py-1.5">
        <div className="text-[10px] text-fg-muted uppercase tracking-wider mb-0.5">Machine ID</div>
        <div className="flex items-center gap-2">
          <code className="text-[11px] text-fg font-mono truncate flex-1" title={status?.machineId}>
            {status?.machineId ?? '…'}
          </code>
          <button onClick={handleCopyMachineId} title="Copy machine ID" className="text-fg-muted hover:text-fg">
            {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
          </button>
        </div>
      </div>

      {/* Relay URL + connect */}
      <div className="rounded-md bg-elevated px-2.5 py-1.5">
        <div className="text-[10px] text-fg-muted uppercase tracking-wider mb-0.5">Relay URL</div>
        <input
          type="url"
          value={relayUrl}
          onChange={e => setRelayUrl(e.target.value)}
          disabled={connected || transitioning}
          placeholder="https://relay.agentplex.dev"
          className="w-full bg-transparent text-[11px] text-fg font-mono outline-none border-b border-border focus:border-fg-muted disabled:opacity-50 pb-0.5"
        />
        <button
          onClick={handleConnectToggle}
          disabled={busy || transitioning}
          className="mt-2 w-full flex items-center justify-center gap-1.5 py-1 rounded text-[11px] font-medium
            bg-border hover:bg-fg-muted/30 text-fg transition-colors disabled:opacity-40"
        >
          {(busy || transitioning) && <Loader2 size={12} className="animate-spin" />}
          {connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      {/* Pairing */}
      <div className="rounded-md bg-elevated px-2.5 py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-fg-muted uppercase tracking-wider">Pair a device</span>
          <button
            onClick={handlePair}
            disabled={!connected}
            className="text-[10px] text-accent hover:underline disabled:opacity-30 disabled:no-underline"
            title={connected ? 'Generate a pairing code' : 'Connect to the relay first'}
          >
            Generate code
          </button>
        </div>
        {pairCode ? (
          <div className="mt-1.5 text-center">
            <div className="text-2xl font-mono tracking-[0.4em] text-fg">{pairCode}</div>
            <div className="text-[10px] text-fg-muted mt-0.5">Expires in {mins}:{secs}</div>
          </div>
        ) : (
          <div className="text-[10px] text-fg-muted mt-1">
            Enter this code in the web/mobile client to pair it with this machine.
          </div>
        )}
      </div>

      {/* Paired devices */}
      <div className="rounded-md bg-elevated px-2.5 py-1.5">
        <div className="text-[10px] text-fg-muted uppercase tracking-wider mb-1">
          Paired devices ({devices.length})
        </div>
        {devices.length === 0 ? (
          <div className="text-[10px] text-fg-muted">No devices paired yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {devices.map(d => (
              <div key={d.deviceId} className="flex items-center gap-2">
                <Smartphone size={12} className="text-fg-muted flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] text-fg truncate">{d.name}</div>
                  <div className="text-[10px] text-fg-muted truncate">{d.platform} · {new Date(d.pairedAt).toLocaleDateString()}</div>
                </div>
                <button onClick={() => handleRevoke(d.deviceId)} title="Revoke device" className="text-fg-muted hover:text-red-400 flex-shrink-0">
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <div className="text-[10px] text-red-400 px-0.5">{error}</div>}
    </div>
  );
}

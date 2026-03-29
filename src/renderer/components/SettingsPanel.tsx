import { useState, useEffect, useCallback, useRef } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import { GitBranchPlus, RefreshCw, Unplug, Check, AlertTriangle, Loader2, HelpCircle } from 'lucide-react';
import { useAppStore } from '../store';
import type { SyncStatusInfo } from '../../shared/ipc-channels';

loader.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });

function SyncStatusBadge({ status }: { status: SyncStatusInfo['status'] }) {
  switch (status) {
    case 'idle':
      return <span className="flex items-center gap-1 text-xs text-green-400"><Check size={12} /> Synced</span>;
    case 'syncing':
      return <span className="flex items-center gap-1 text-xs text-accent"><Loader2 size={12} className="animate-spin" /> Syncing...</span>;
    case 'conflict':
      return <span className="flex items-center gap-1 text-xs text-yellow-400"><AlertTriangle size={12} /> Conflict</span>;
    case 'error':
      return <span className="flex items-center gap-1 text-xs text-red-400"><AlertTriangle size={12} /> Error</span>;
    case 'not-configured':
      return <span className="text-xs text-fg-muted">Not configured</span>;
  }
}

export function SettingsPanel() {
  const syncStatus = useAppStore((s) => s.syncStatus);
  const updatePreferences = useAppStore((s) => s.updatePreferences);
  const updateSyncStatus = useAppStore((s) => s.updateSyncStatus);

  const [ghUser, setGhUser] = useState<{ username: string; host: string } | null>(null);
  const [ghChecking, setGhChecking] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginCode, setLoginCode] = useState<string | null>(null);
  const [loginHost, setLoginHost] = useState('github.com');

  // JSON editor state
  const [jsonText, setJsonText] = useState('{}');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localEditRef = useRef(false); // true while the editor has a pending save

  const refreshSettings = useCallback(async () => {
    const s = await window.agentPlex.getAllSettings();
    updatePreferences(s);
    setJsonText(JSON.stringify(s, null, 2));
    setJsonError(null);
  }, [updatePreferences]);

  // Load on mount
  useEffect(() => {
    refreshSettings();
    window.agentPlex.syncStatus().then(updateSyncStatus);
    window.agentPlex.syncGetGitHubUser().then((u) => {
      setGhUser(u);
      setGhChecking(false);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return window.agentPlex.onSyncStatusChanged(updateSyncStatus);
  }, [updateSyncStatus]);

  useEffect(() => {
    return window.agentPlex.onSettingsChanged((s) => {
      updatePreferences(s);
      // Only update editor text if WE didn't initiate the change (avoids feedback loop)
      if (!localEditRef.current) {
        setJsonText(JSON.stringify(s, null, 2));
        setJsonError(null);
      }
    });
  }, [updatePreferences]);

  // Auto-save JSON edits with debounce
  const handleJsonChange = useCallback((value: string | undefined) => {
    if (!value) return;
    setJsonText(value);
    localEditRef.current = true;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      try {
        const parsed = JSON.parse(value);
        setJsonError(null);
        window.agentPlex.updateSettings(parsed);
        updatePreferences(parsed);
      } catch {
        setJsonError('Invalid JSON');
      }
      localEditRef.current = false;
    }, 800);
  }, [updatePreferences]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const result = await window.agentPlex.syncSetupAuto();
      updateSyncStatus(result);
      if (result.status === 'idle') {
        await refreshSettings();
      }
    } finally {
      setConnecting(false);
    }
  }, [updateSyncStatus, refreshSettings]);

  const handleDisconnect = useCallback(async () => {
    await window.agentPlex.syncDisconnect();
    updateSyncStatus({ status: 'not-configured', lastSyncedAt: null });
  }, [updateSyncStatus]);

  const handleSync = useCallback(async () => {
    let result = await window.agentPlex.syncPull();
    updateSyncStatus(result);
    if (result.status === 'idle') {
      await refreshSettings();
      result = await window.agentPlex.syncPush();
      updateSyncStatus(result);
    }
  }, [updateSyncStatus, refreshSettings]);

  const isConfigured = syncStatus.status !== 'not-configured';
  const isSyncing = syncStatus.status === 'syncing';

  const inputCls = 'w-full px-2 py-1 bg-inset border border-border rounded text-sm text-fg focus:outline-none focus:border-accent';
  const btnCls = 'px-3 py-1.5 rounded text-xs font-medium transition-colors cursor-pointer';
  const btnPrimary = `${btnCls} bg-accent text-fg hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed`;
  const btnDanger = `${btnCls} bg-red-900/30 text-red-400 hover:bg-red-900/50 disabled:opacity-40`;

  return (
    <div className="h-full flex flex-col bg-surface overflow-hidden">
      <div className="p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-fg">Settings</h2>
      </div>

      <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
        {/* ── JSON Editor ─────────────────────────────────────────── */}
        <section className="flex flex-col min-h-[200px]" style={{ height: '40%' }}>
          <div className="flex items-center justify-between px-4 py-2 border-b border-border">
            <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
              settings.json
            </h3>
            {jsonError && (
              <span className="text-xs text-red-400">{jsonError}</span>
            )}
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              language="json"
              theme="vs-dark"
              value={jsonText}
              onChange={handleJsonChange}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: 'off',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 2,
                folding: true,
                renderLineHighlight: 'none',
                overviewRulerLanes: 0,
                hideCursorInOverviewRuler: true,
                scrollbar: { vertical: 'auto', horizontal: 'hidden' },
                padding: { top: 8 },
              }}
            />
          </div>
        </section>

        <div className="p-4 space-y-6">
          {/* ── Settings Sync ───────────────────────────────────────── */}
          <section>
            <div className="flex items-center gap-1.5 mb-3">
              <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">
                Settings Sync
              </h3>
              <div className="relative group">
                <HelpCircle size={12} className="text-fg-muted cursor-help" />
                <div className="absolute left-0 top-full mt-1 w-56 p-2.5 bg-elevated border border-border-strong rounded-lg shadow-lg text-xs text-fg-muted opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-50">
                  <p className="font-medium text-fg mb-1.5">Syncs across machines:</p>
                  <ul className="space-y-0.5 mb-1.5">
                    <li>AgentPlex preferences</li>
                    <li>~/.claude/ files configured in <code className="text-accent">syncClaudeIncludes</code></li>
                  </ul>
                  <p className="text-[10px] italic">Session history, projects, and credentials are never synced. Edit syncClaudeIncludes above to customize.</p>
                </div>
              </div>
            </div>

            {!isConfigured ? (
              <div className="space-y-3">
                <p className="text-xs text-fg-muted">
                  Sync preferences and Claude config across machines via a private GitHub repo.
                  A repo named <span className="font-mono text-fg">agentplex-sync</span> will be
                  auto-created on your GitHub account.
                </p>

                {ghChecking ? (
                  <div className="flex items-center gap-2 text-xs text-fg-muted">
                    <Loader2 size={12} className="animate-spin" /> Checking GitHub CLI...
                  </div>
                ) : ghUser ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-xs">
                      <GitBranchPlus size={14} className="text-fg-muted" />
                      <span className="text-fg">{ghUser.username}</span>
                      <span className="text-fg-muted">on {ghUser.host}</span>
                    </div>
                    <button onClick={handleConnect} disabled={connecting} className={btnPrimary}>
                      {connecting ? (
                        <><Loader2 size={12} className="inline mr-1 animate-spin" />Connecting...</>
                      ) : (
                        <><GitBranchPlus size={12} className="inline mr-1" />Connect to GitHub</>
                      )}
                    </button>
                  </div>
                ) : loggingIn ? (
                  <div className="space-y-2">
                    {loginCode ? (
                      <>
                        <p className="text-xs text-fg-muted">
                          A browser window should have opened. Enter this code:
                        </p>
                        <div className="flex items-center justify-center py-2">
                          <code className="text-lg font-bold text-accent bg-inset px-4 py-2 rounded-lg tracking-widest">
                            {loginCode}
                          </code>
                        </div>
                        <p className="text-xs text-fg-muted flex items-center gap-1">
                          <Loader2 size={12} className="animate-spin" /> Waiting for browser authentication...
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-fg-muted flex items-center gap-1">
                        <Loader2 size={12} className="animate-spin" /> Opening browser...
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div>
                      <label className="block text-xs text-fg-muted mb-1">GitHub Host</label>
                      <input
                        type="text"
                        value={loginHost}
                        onChange={(e) => setLoginHost(e.target.value)}
                        className={inputCls}
                      />
                    </div>
                    <button
                      onClick={async () => {
                        setLoggingIn(true);
                        setLoginCode(null);
                        const cleanup = window.agentPlex.onGhLoginProgress((p) => {
                          if (p.code) setLoginCode(p.code);
                        });
                        const result = await window.agentPlex.syncGhLogin(loginHost);
                        cleanup();
                        setLoggingIn(false);
                        setLoginCode(null);
                        if (result.status === 'success') {
                          const u = await window.agentPlex.syncGetGitHubUser();
                          setGhUser(u);
                        }
                      }}
                      className={btnPrimary}
                    >
                      <GitBranchPlus size={12} className="inline mr-1" />Log in to GitHub
                    </button>
                  </div>
                )}

                {syncStatus.error && (
                  <p className="text-xs text-red-400 bg-red-900/20 px-2 py-1 rounded">
                    {syncStatus.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <SyncStatusBadge status={syncStatus.status} />
                  {syncStatus.lastSyncedAt && (
                    <span className="text-xs text-fg-muted">
                      {new Date(syncStatus.lastSyncedAt).toLocaleString()}
                    </span>
                  )}
                </div>

                {syncStatus.error && (
                  <p className="text-xs text-red-400 bg-red-900/20 px-2 py-1 rounded">
                    {syncStatus.error}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleSync}
                    disabled={isSyncing}
                    className={btnPrimary}
                  >
                    <RefreshCw size={12} className="inline mr-1" />Sync Now
                  </button>
                  <button onClick={handleDisconnect} className={btnDanger}>
                    <Unplug size={12} className="inline mr-1" />Disconnect
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

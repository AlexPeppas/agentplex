import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar';
import { GraphCanvas } from './components/GraphCanvas';
import { TerminalPanel } from './components/TerminalPanel';
import { SendDialog } from './components/SendDialog';
import { ProjectLauncher } from './components/ProjectLauncher';
import { ActivityBar } from './components/ActivityBar';
import { SidePanel } from './components/SidePanel';
import { useAppStore } from './store';
import { SessionStatus } from '../shared/ipc-channels';
import './types';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return <div style={{ padding: 20, color: '#e07070', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
        <h2>Renderer crashed</h2>
        <p>{this.state.error.message}</p>
        <pre>{this.state.error.stack}</pre>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: 10, padding: '4px 12px' }}>Retry</button>
      </div>;
    }
    return this.props.children;
  }
}

let sharedAudioCtx: AudioContext | null = null;

function playBell() {
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioContext();
  }
  const ctx = sharedAudioCtx;
  if (ctx.state === 'suspended') {
    ctx.resume();
  }
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.frequency.value = 880;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.3, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
  osc.start();
  osc.stop(ctx.currentTime + 0.3);
}

export function App() {
  const hasOpenPanes = useAppStore((s) => s.openPanes.length > 0);
  const sendDialogSourceId = useAppStore((s) => s.sendDialogSourceId);
  const launcherOpen = useAppStore((s) => s.launcherOpen);
  const addSession = useAppStore((s) => s.addSession);
  const appendBuffer = useAppStore((s) => s.appendBuffer);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const spawnSubagent = useAppStore((s) => s.spawnSubagent);
  const completeSubagent = useAppStore((s) => s.completeSubagent);
  const enterPlan = useAppStore((s) => s.enterPlan);
  const exitPlan = useAppStore((s) => s.exitPlan);
  const createTask = useAppStore((s) => s.createTask);
  const updateTask = useAppStore((s) => s.updateTask);
  const reconcileTasks = useAppStore((s) => s.reconcileTasks);
  const prevStatuses = useRef<Map<string, SessionStatus>>(new Map());

  const renameSession = useAppStore((s) => s.renameSession);

  const [terminalWidth, setTerminalWidth] = useState(40); // percentage
  const dragging = useRef(false);
  const outerRef = useRef<HTMLDivElement>(null);
  const mainAreaRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !mainAreaRef.current) return;
      const rect = mainAreaRef.current.getBoundingClientRect();
      const pct = ((rect.right - ev.clientX) / rect.width) * 100;
      setTerminalWidth(Math.max(20, Math.min(80, pct)));
    };

    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const activePanelId = useAppStore((s) => s.activePanelId);
  const setSidePanelWidth = useAppStore((s) => s.setSidePanelWidth);

  const sidePanelDragging = useRef(false);

  const handleSidePanelResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidePanelDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (ev: MouseEvent) => {
      if (!sidePanelDragging.current || !outerRef.current) return;
      const rect = outerRef.current.getBoundingClientRect();
      // 48px for the activity bar
      const newWidth = ev.clientX - rect.left - 48;
      setSidePanelWidth(newWidth);
    };

    const onUp = () => {
      sidePanelDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setSidePanelWidth]);

  // Reconnect to existing sessions on mount (e.g. after renderer reload/crash)
  // and restore persisted Claude sessions from state.json
  useEffect(() => {
    const reconnect = async () => {
      // Reconnect to sessions that survived a renderer reload
      const existing = await window.agentPlex.listSessions();
      const knownIds = new Set(Object.keys(useAppStore.getState().sessions));

      if (existing.length > 0) {
        // Renderer reload — load display names from state.json (IDs still valid)
        const savedNames = await window.agentPlex.getDisplayNames();

        for (const info of existing) {
          if (knownIds.has(info.id)) continue;
          addSession(info);
          updateStatus(info.id, info.status);
          // Apply persisted display name to node label
          if (savedNames[info.id]) {
            renameSession(info.id, savedNames[info.id]);
          }
          try {
            const buffer = await window.agentPlex.getSessionBuffer(info.id);
            if (buffer) {
              appendBuffer(info.id, buffer);
            }
          } catch {
            // Handler may not be registered if main process hasn't restarted
          }
        }
      } else {
        // Fresh launch — don't load old display names (stale IDs would collide
        // with new session IDs since sessionCounter resets to 0).
        // The restore loop below will set correct display names for restored sessions.
        try {
          const restored = await window.agentPlex.restoreAllSessions();
          for (const { info, displayName } of restored) {
            addSession(info);
            if (displayName) {
              renameSession(info.id, displayName);
            }
          }
          if (restored.length > 0) {
            console.log(`[restore] Restored ${restored.length} session(s)`);
          }
        } catch (err) {
          console.error('[restore] Failed:', err);
        }
      }
    };
    reconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to IPC events
  useEffect(() => {
    const cleanupData = window.agentPlex.onSessionData(({ id, data }) => {
      appendBuffer(id, data);
    });

    const cleanupStatus = window.agentPlex.onSessionStatus(({ id, status }) => {
      const prev = prevStatuses.current.get(id);
      if (status === SessionStatus.WaitingForInput && prev !== SessionStatus.WaitingForInput) {
        playBell();
      }
      prevStatuses.current.set(id, status);
      updateStatus(id, status);
    });

    const cleanupExit = window.agentPlex.onSessionExit(({ id }) => {
      updateStatus(id, SessionStatus.Killed);
    });

    const cleanupSpawn = window.agentPlex.onSubagentSpawn(({ sessionId, subagentId, description }) => {
      spawnSubagent(sessionId, subagentId, description);
    });

    const cleanupComplete = window.agentPlex.onSubagentComplete(({ sessionId, subagentId }) => {
      completeSubagent(sessionId, subagentId);
    });

    const cleanupPlanEnter = window.agentPlex.onPlanEnter(({ sessionId, planTitle }) => {
      enterPlan(sessionId, planTitle);
    });

    const cleanupPlanExit = window.agentPlex.onPlanExit(({ sessionId }) => {
      exitPlan(sessionId);
    });

    const cleanupTaskCreate = window.agentPlex.onTaskCreate(({ sessionId, taskNumber, description }) => {
      createTask(sessionId, taskNumber, description);
    });

    const cleanupTaskUpdate = window.agentPlex.onTaskUpdate(({ sessionId, taskNumber, status }) => {
      updateTask(sessionId, taskNumber, status);
    });

    const cleanupTaskList = window.agentPlex.onTaskList(({ sessionId, tasks }) => {
      reconcileTasks(sessionId, tasks);
    });

    return () => {
      cleanupData();
      cleanupStatus();
      cleanupExit();
      cleanupSpawn();
      cleanupComplete();
      cleanupPlanEnter();
      cleanupPlanExit();
      cleanupTaskCreate();
      cleanupTaskUpdate();
      cleanupTaskList();
    };
  }, [appendBuffer, updateStatus, spawnSubagent, completeSubagent, enterPlan, exitPlan, createTask, updateTask, reconcileTasks]);

  return (
    <div className="flex flex-col h-full">
      <Toolbar />
      <div className="flex flex-1 overflow-hidden" ref={outerRef}>
        <ActivityBar />
        {activePanelId && (
          <>
            <SidePanel />
            <div
              className="flex-[0_0_4px] cursor-col-resize bg-border transition-colors duration-[120ms] hover:bg-accent active:bg-accent"
              onMouseDown={handleSidePanelResizeStart}
            />
          </>
        )}
        <div className="flex flex-1 min-w-0 overflow-hidden" ref={mainAreaRef}>
          <div
            className="flex-1 min-w-0 h-full"
            style={hasOpenPanes ? { flex: `0 0 ${100 - terminalWidth}%` } : undefined}
          >
            <ReactFlowProvider>
              <GraphCanvas />
            </ReactFlowProvider>
          </div>
          {hasOpenPanes && (
            <>
              <div
                className="flex-[0_0_4px] cursor-col-resize bg-border transition-colors duration-[120ms] hover:bg-accent active:bg-accent"
                onMouseDown={handleResizeStart}
              />
              <div className="min-w-0 h-full" style={{ flex: `0 0 ${terminalWidth}%` }}>
                <ErrorBoundary>
                  <TerminalPanel />
                </ErrorBoundary>
              </div>
            </>
          )}
        </div>
      </div>
      {sendDialogSourceId && <SendDialog />}
      {launcherOpen && <ProjectLauncher />}
    </div>
  );
}

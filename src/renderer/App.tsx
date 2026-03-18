import { useEffect, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar';
import { GraphCanvas } from './components/GraphCanvas';
import { TerminalPanel } from './components/TerminalPanel';
import { SendDialog } from './components/SendDialog';
import { useAppStore } from './store';
import { SessionStatus } from '../shared/ipc-channels';
import './types';

function playBell() {
  const ctx = new AudioContext();
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
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const sendDialogSourceId = useAppStore((s) => s.sendDialogSourceId);
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

  // Reconnect to existing sessions on mount (e.g. after renderer reload/crash)
  // and restore persisted Claude sessions from state.json
  useEffect(() => {
    const reconnect = async () => {
      // Load persisted display names from ~/.agentplex
      const savedNames = await window.agentPlex.loadDisplayNames();
      if (Object.keys(savedNames).length > 0) {
        useAppStore.setState({ displayNames: savedNames });
      }

      // Reconnect to sessions that survived a renderer reload
      const existing = await window.agentPlex.listSessions();
      const knownIds = new Set(Object.keys(useAppStore.getState().sessions));
      for (const info of existing) {
        if (knownIds.has(info.id)) continue;
        addSession(info);
        updateStatus(info.id, info.status);
        try {
          const buffer = await window.agentPlex.getSessionBuffer(info.id);
          if (buffer) {
            appendBuffer(info.id, buffer);
          }
        } catch {
          // Handler may not be registered if main process hasn't restarted
        }
      }

      // Restore persisted Claude sessions (only on fresh launch, not renderer reload)
      if (existing.length === 0) {
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
    <div className="app">
      <Toolbar />
      <div className="app__content">
        <div className={`app__graph ${selectedSessionId ? 'app__graph--split' : ''}`}>
          <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>
        </div>
        {selectedSessionId && (
          <div className="app__terminal">
            <TerminalPanel />
          </div>
        )}
      </div>
      {sendDialogSourceId && <SendDialog />}
    </div>
  );
}

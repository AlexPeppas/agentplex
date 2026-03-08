import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar';
import { GraphCanvas } from './components/GraphCanvas';
import { TerminalPanel } from './components/TerminalPanel';
import { SendDialog } from './components/SendDialog';
import { useAppStore } from './store';
import { SessionStatus } from '../shared/ipc-channels';
import './types';

export function App() {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const sendDialogSourceId = useAppStore((s) => s.sendDialogSourceId);
  const addSession = useAppStore((s) => s.addSession);
  const appendBuffer = useAppStore((s) => s.appendBuffer);
  const updateStatus = useAppStore((s) => s.updateStatus);
  const spawnSubagent = useAppStore((s) => s.spawnSubagent);
  const completeSubagent = useAppStore((s) => s.completeSubagent);
  const cleanupStaleSubagents = useAppStore((s) => s.cleanupStaleSubagents);
  const enterPlan = useAppStore((s) => s.enterPlan);
  const exitPlan = useAppStore((s) => s.exitPlan);
  const createTask = useAppStore((s) => s.createTask);
  const updateTask = useAppStore((s) => s.updateTask);
  const reconcileTasks = useAppStore((s) => s.reconcileTasks);

  // Reconnect to existing sessions on mount (e.g. after renderer reload/crash)
  useEffect(() => {
    const reconnect = async () => {
      const existing = await window.agentField.listSessions();
      const knownIds = new Set(Object.keys(useAppStore.getState().sessions));
      for (const info of existing) {
        if (knownIds.has(info.id)) continue;
        addSession(info);
        updateStatus(info.id, info.status);
        // Replay buffered output from main process
        const buffer = await window.agentField.getSessionBuffer(info.id);
        if (buffer) {
          appendBuffer(info.id, buffer);
        }
      }
    };
    reconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodically clean up sub-agents stuck in "active" state (missed completion events)
  useEffect(() => {
    const timer = setInterval(cleanupStaleSubagents, 30_000);
    return () => clearInterval(timer);
  }, [cleanupStaleSubagents]);

  // Subscribe to IPC events
  useEffect(() => {
    const cleanupData = window.agentField.onSessionData(({ id, data }) => {
      appendBuffer(id, data);
    });

    const cleanupStatus = window.agentField.onSessionStatus(({ id, status }) => {
      updateStatus(id, status);
    });

    const cleanupExit = window.agentField.onSessionExit(({ id }) => {
      updateStatus(id, SessionStatus.Killed);
    });

    const cleanupSpawn = window.agentField.onSubagentSpawn(({ sessionId, subagentId, description }) => {
      spawnSubagent(sessionId, subagentId, description);
    });

    const cleanupComplete = window.agentField.onSubagentComplete(({ sessionId, subagentId }) => {
      completeSubagent(sessionId, subagentId);
    });

    const cleanupPlanEnter = window.agentField.onPlanEnter(({ sessionId, planTitle }) => {
      enterPlan(sessionId, planTitle);
    });

    const cleanupPlanExit = window.agentField.onPlanExit(({ sessionId }) => {
      exitPlan(sessionId);
    });

    const cleanupTaskCreate = window.agentField.onTaskCreate(({ sessionId, taskNumber, description }) => {
      createTask(sessionId, taskNumber, description);
    });

    const cleanupTaskUpdate = window.agentField.onTaskUpdate(({ sessionId, taskNumber, status }) => {
      updateTask(sessionId, taskNumber, status);
    });

    const cleanupTaskList = window.agentField.onTaskList(({ sessionId, tasks }) => {
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

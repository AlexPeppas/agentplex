import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Toolbar } from './components/Toolbar';
import { GraphCanvas } from './components/GraphCanvas';
import { TerminalPanel } from './components/TerminalPanel';
import { useAppStore } from './store';
import { SessionStatus } from '../shared/ipc-channels';
import './types';

export function App() {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const appendBuffer = useAppStore((s) => s.appendBuffer);
  const updateStatus = useAppStore((s) => s.updateStatus);

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

    return () => {
      cleanupData();
      cleanupStatus();
      cleanupExit();
    };
  }, [appendBuffer, updateStatus]);

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
    </div>
  );
}

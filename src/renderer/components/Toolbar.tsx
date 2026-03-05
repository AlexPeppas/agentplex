import { useCallback } from 'react';
import { useAppStore } from '../store';

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);

  const handleNewSession = useCallback(async () => {
    const cwd = await window.agentField.pickDirectory();
    if (!cwd) return; // user cancelled
    const info = await window.agentField.createSession(cwd);
    addSession(info);
  }, [addSession]);

  return (
    <div className="toolbar">
      <span className="toolbar__title">Agent Field</span>
      <button className="toolbar__button" onClick={handleNewSession}>
        + New Session
      </button>
    </div>
  );
}

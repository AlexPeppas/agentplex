import { useCallback } from 'react';
import { useAppStore } from '../store';

export function Toolbar() {
  const addSession = useAppStore((s) => s.addSession);

  const handleNewSession = useCallback(async () => {
    const info = await window.agentField.createSession();
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

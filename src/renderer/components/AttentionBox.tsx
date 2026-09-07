import { Bell, ChevronRight } from 'lucide-react';
import { useAppStore } from '../store';
import { attentionSessions } from '../session-explorer';

export function AttentionBox() {
  const sessions = useAppStore(s => s.sessions);
  const names = useAppStore(s => s.displayNames);
  const activeId = useAppStore(s => s.activePaneId);
  const selectSession = useAppStore(s => s.selectSession);
  const waiting = attentionSessions(Object.values(sessions), names);

  return (
    <section aria-label="Needs attention" className="m-2 rounded-lg border border-border bg-elevated overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold text-fg">
        <Bell size={14} className="shrink-0" />
        <span className="flex-1">Needs attention</span>
        <span role="status" aria-label={`${waiting.length} sessions waiting for input`} className="tabular-nums text-fg-muted">
          {waiting.length}
        </span>
      </div>
      {waiting.length === 0 ? (
        <p className="px-2.5 pb-2 text-[11px] text-fg-muted">No sessions waiting for input.</p>
      ) : (
        <>
          <p className="px-2.5 pb-2 text-[10px] text-fg-muted">Open a session to review its question or permission request.</p>
          <div className="max-h-48 overflow-y-auto">
            {waiting.map(session => (
              <button
                key={session.id}
                onClick={() => selectSession(session.id, true)}
                aria-label={`Review ${session.label}`}
                aria-current={activeId === session.id ? 'true' : undefined}
                title={`${session.label} - ${session.cwd}`}
                className={`flex items-center gap-2 w-full px-2.5 py-2 text-left hover:bg-border focus-visible:outline focus-visible:outline-accent ${activeId === session.id ? 'bg-accent-subtle' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">{session.label}</span>
                  <span className="block truncate text-[10px] text-fg-muted">{session.cli} · {session.cwd}</span>
                </span>
                <ChevronRight size={14} className="shrink-0 text-fg-muted" />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

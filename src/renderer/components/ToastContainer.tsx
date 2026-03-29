import { X } from 'lucide-react';
import { useAppStore } from '../store';
import { CliIcon } from './SessionNode';

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const dismissToast = useAppStore((s) => s.dismissToast);
  const selectSession = useAppStore((s) => s.selectSession);
  const sessions = useAppStore((s) => s.sessions);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-[900] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => {
        const session = sessions[toast.sessionId];
        return (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center gap-3 bg-elevated border border-border-strong rounded-lg px-4 py-3 shadow-[0_8px_24px_var(--shadow-heavy)] min-w-[280px] max-w-[380px] animate-[slide-in-right_0.2s_ease-out]"
          >
            <button
              className="flex items-center gap-3 flex-1 min-w-0 bg-transparent border-none cursor-pointer text-left p-0"
              onClick={() => { selectSession(toast.sessionId, true); dismissToast(toast.id); }}
            >
              <CliIcon cli={session?.cli} size={20} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-fg truncate">{toast.name}</div>
                <div className="text-[11px] text-warning">Waiting for input</div>
              </div>
            </button>
            <button
              className="shrink-0 w-6 h-6 flex items-center justify-center rounded bg-transparent border-none text-fg-muted cursor-pointer transition-colors hover:bg-border hover:text-fg"
              onClick={() => dismissToast(toast.id)}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

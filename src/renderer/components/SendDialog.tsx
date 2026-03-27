import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { useAppStore } from '../store';
import { SessionStatus } from '../../shared/ipc-channels';
import { stripAnsi } from '../../shared/ansi-strip';

const CONTEXT_MAX_LINES = 100;
const CONTEXT_MAX_CHARS = 8000;

function extractContext(buffer: string): string {
  const stripped = stripAnsi(buffer);
  const lines = stripped.split('\n');
  let context = lines.slice(-CONTEXT_MAX_LINES).join('\n');
  if (context.length > CONTEXT_MAX_CHARS) {
    context = context.slice(-CONTEXT_MAX_CHARS);
  }
  return context.trim();
}

export function SendDialog() {
  const sourceId = useAppStore((s) => s.sendDialogSourceId);
  const closeSendDialog = useAppStore((s) => s.closeSendDialog);
  const flashMessageEdge = useAppStore((s) => s.flashMessageEdge);
  const sessions = useAppStore((s) => s.sessions);
  const sessionBuffers = useAppStore((s) => s.sessionBuffers);
  const displayNames = useAppStore((s) => s.displayNames);
  const [targetId, setTargetId] = useState<string>('');
  const [instruction, setInstruction] = useState('');
  const [summarize, setSummarize] = useState(true);
  const [sending, setSending] = useState(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);

  // All live (non-killed) sessions except the source
  const targetSessions = Object.values(sessions).filter(
    (s) => s.id !== sourceId && s.status !== SessionStatus.Killed
  );

  const sourceLabel = sourceId
    ? displayNames[sourceId] || sessions[sourceId]?.title || sourceId
    : sourceId;

  const contextPreview = useMemo(() => {
    if (!sourceId || !sessionBuffers[sourceId]) return '';
    return extractContext(sessionBuffers[sourceId]);
  }, [sourceId, sessionBuffers]);

  // Pick first available target, or reset if current target is gone
  useEffect(() => {
    const validTarget = targetSessions.find((s) => s.id === targetId);
    if (!validTarget && targetSessions.length > 0) {
      setTargetId(targetSessions[0].id);
    } else if (targetSessions.length === 0) {
      setTargetId('');
    }
  }, [targetSessions, targetId]);

  useEffect(() => {
    instructionRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    if (!targetId || !instruction.trim() || sending) return;

    let contextBlock = contextPreview;

    if (summarize && contextPreview) {
      setSending(true);
      try {
        const result = await window.agentPlex.summarizeContext(contextPreview, sourceLabel || 'session');
        if (result.summary) {
          contextBlock = result.summary;
        }
        // On error, fall back to raw context silently
      } catch {
        // fall back to raw context
      }
      setSending(false);
    }

    const message = [
      instruction.trim(),
      '',
      '<summary_context>',
      `Context from ${sourceLabel}, another session instance of you:`,
      contextBlock,
      '</summary_context>',
    ].join('\n');

    // Use bracketed paste so Claude CLI treats multi-line input as a single paste,
    // then send Enter after a generous delay so the TUI fully processes the paste.
    // Retry Enter a few times — the TUI can sometimes swallow the first one.
    const bracketedPaste = `\x1b[200~${message}\x1b[201~`;
    const tid = targetId;
    window.agentPlex.writeSession(tid, bracketedPaste);
    const sendEnter = (delay: number) => {
      setTimeout(() => {
        window.agentPlex.writeSession(tid, '\r');
      }, delay);
    };
    sendEnter(800);
    sendEnter(1500);
    sendEnter(2200);

    if (sourceId) flashMessageEdge(sourceId, tid);
    setInstruction('');
    closeSendDialog();
  }, [targetId, instruction, sourceId, sourceLabel, contextPreview, summarize, sending, sessions, closeSendDialog, flashMessageEdge]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSendDialog();
      } else if (e.key === 'Enter' && (window.agentPlex.platform === 'darwin' ? e.metaKey : e.ctrlKey)) {
        handleSend();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeSendDialog, handleSend]);

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      closeSendDialog();
    }
  };

  return (
    <div className="fixed inset-0 bg-backdrop flex items-center justify-center z-[1000]" onClick={handleBackdropClick}>
      <div className="bg-elevated border border-border-strong rounded-xl p-5 w-[520px] max-w-[90vw] shadow-[0_8px_32px_var(--shadow-heavy)]">
        <div className="text-sm font-semibold text-fg mb-3.5">
          Send context from: {sourceLabel}
        </div>

        <label className="block text-xs font-medium text-fg-muted mb-1.5">To:</label>
        {targetSessions.length === 0 ? (
          <div className="py-2 px-2.5 text-[13px] text-fg-muted mb-3">No other active sessions</div>
        ) : (
          <select
            className="w-full py-2 px-2.5 bg-surface border border-border-strong rounded-lg text-fg text-[13px] outline-none mb-3 cursor-pointer transition-colors focus:border-accent"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            {targetSessions.map((s) => (
              <option key={s.id} value={s.id}>
                {displayNames[s.id] || s.title}
              </option>
            ))}
          </select>
        )}

        <label className="block text-xs font-medium text-fg-muted mb-1.5">Context preview:</label>
        <div className="w-full max-h-[200px] overflow-y-auto bg-inset border border-border rounded-lg text-fg-muted font-mono text-xs p-2.5 whitespace-pre-wrap break-all mb-3">
          {contextPreview || '(no output yet)'}
        </div>

        <label className="block text-xs font-medium text-fg-muted mb-1.5">Instruction:</label>
        <textarea
          ref={instructionRef}
          className="w-full bg-surface border border-border-strong rounded-lg text-fg font-mono text-[13px] p-2.5 resize-y outline-none transition-colors focus:border-accent placeholder:text-fg-muted"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. Continue this refactor, review this output..."
          rows={3}
        />

        <div className="mt-2.5">
          <label className="inline-flex items-center gap-1.5 text-xs text-fg-muted cursor-pointer">
            <input
              type="checkbox"
              className="accent-accent cursor-pointer"
              checked={summarize}
              onChange={(e) => setSummarize(e.target.checked)}
            />
            <span>Summarize with Haiku</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-3.5">
          <button className="py-1.5 px-3.5 bg-transparent border border-border-strong rounded-md text-fg text-[13px] cursor-pointer transition-colors hover:bg-border" onClick={closeSendDialog}>
            Cancel
          </button>
          <button
            className="py-1.5 px-3.5 bg-accent text-surface border-none rounded-md text-[13px] font-semibold cursor-pointer transition-colors hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleSend}
            disabled={!instruction.trim() || !targetId || sending}
          >
            {sending ? 'Summarizing...' : <><span>Send</span> <CornerDownLeft size={13} className="inline -mt-px" /></>}
          </button>
        </div>
      </div>
    </div>
  );
}

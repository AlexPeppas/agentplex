import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    <div className="send-dialog__backdrop" onClick={handleBackdropClick}>
      <div className="send-dialog">
        <div className="send-dialog__header">
          Send context from: {sourceLabel}
        </div>

        <label className="send-dialog__label">To:</label>
        {targetSessions.length === 0 ? (
          <div className="send-dialog__no-targets">No other active sessions</div>
        ) : (
          <select
            className="send-dialog__select"
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

        <label className="send-dialog__label">Context preview:</label>
        <div className="send-dialog__context-preview">
          {contextPreview || '(no output yet)'}
        </div>

        <label className="send-dialog__label">Instruction:</label>
        <textarea
          ref={instructionRef}
          className="send-dialog__textarea"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="e.g. Continue this refactor, review this output..."
          rows={3}
        />

        <div className="send-dialog__options">
          <label className="send-dialog__toggle">
            <input
              type="checkbox"
              checked={summarize}
              onChange={(e) => setSummarize(e.target.checked)}
            />
            <span>Summarize with Haiku</span>
          </label>
        </div>

        <div className="send-dialog__actions">
          <button className="send-dialog__cancel" onClick={closeSendDialog}>
            Cancel
          </button>
          <button
            className="send-dialog__send"
            onClick={handleSend}
            disabled={!instruction.trim() || !targetId || sending}
          >
            {sending ? 'Summarizing...' : 'Send \u23CE'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  const sessions = useAppStore((s) => s.sessions);
  const sessionBuffers = useAppStore((s) => s.sessionBuffers);
  const displayNames = useAppStore((s) => s.displayNames);
  const [targetId, setTargetId] = useState<string>('');
  const [instruction, setInstruction] = useState('');
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

  const handleSend = useCallback(() => {
    if (!targetId || !instruction.trim()) return;

    const targetTitle = sessions[targetId]?.title || targetId;
    void targetTitle; // target title not needed in the message

    const message = [
      instruction.trim(),
      '',
      '<summary_context>',
      `Context from ${sourceLabel}, another session instance of you:`,
      contextPreview,
      '</summary_context>',
    ].join('\n');

    // Use bracketed paste so Claude CLI treats multi-line input as a single paste,
    // then send Enter after a delay so the TUI fully processes the paste first.
    const bracketedPaste = `\x1b[200~${message}\x1b[201~`;
    const tid = targetId;
    window.agentPlex.writeSession(tid, bracketedPaste);
    setTimeout(() => {
      window.agentPlex.writeSession(tid, '\r');
      // Fallback: some TUI frameworks on Windows need \n instead of \r
      setTimeout(() => window.agentPlex.writeSession(tid, '\n'), 100);
    }, 500);

    setInstruction('');
    closeSendDialog();
  }, [targetId, instruction, sourceLabel, contextPreview, sessions, closeSendDialog]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSendDialog();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
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
        <div className="send-dialog__actions">
          <button className="send-dialog__cancel" onClick={closeSendDialog}>
            Cancel
          </button>
          <button
            className="send-dialog__send"
            onClick={handleSend}
            disabled={!instruction.trim() || !targetId}
          >
            Send ⏎
          </button>
        </div>
      </div>
    </div>
  );
}

import { Children, memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, LoaderCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConversationEntry, ConversationSnapshot, ConversationUpdate } from '../../shared/ipc-channels';
import { EMPTY_CONVERSATION, applyConversationUpdate } from '../../shared/conversation';
import { findArtifactReferences } from '../../shared/artifact-links';
import { stripAnsi } from '../../shared/ansi-strip';
import { ConversationCode } from './ConversationCode';

interface MessageProps {
  entry: ConversationEntry;
  onOpenFile: (reference: string) => void;
  onError: (error: string) => void;
}

function conversationUrl(url: string): string {
  return /^(?:https?:|file:)/i.test(url) || /^[a-z]:[\\/]/i.test(url) || !/^[a-z][a-z\d+.-]*:/i.test(url) ? url : '';
}

const ConversationMessage = memo(function ConversationMessage({ entry, onOpenFile, onError }: MessageProps) {
  const linkify = (children: ReactNode) => Children.map(children, child => {
    if (typeof child !== 'string') return child;
    const links = findArtifactReferences(child).filter(link => conversationUrl(link.reference));
    let offset = 0;
    const parts: ReactNode[] = [];
    for (const link of links) {
      parts.push(child.slice(offset, link.start));
      parts.push(<a key={link.start} href={link.reference} onClick={event => {
        event.preventDefault();
        onOpenFile(link.reference);
      }}>{child.slice(link.start, link.end)}</a>);
      offset = link.end;
    }
    parts.push(child.slice(offset));
    return parts;
  });
  const text = stripAnsi(entry.text);
  const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;
  const time = timestamp && Number.isFinite(timestamp.getTime())
    ? timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return <div className={`copilot-message copilot-message--${entry.kind}`} data-conversation-kind={entry.kind}>
    <span className="copilot-message-marker" aria-hidden="true">{entry.kind === 'user' ? '❯' : '●'}</span>
    <div className="copilot-message-content">
      {entry.kind === 'user' && <div className="copilot-prompt">{linkify(text)}</div>}
      {entry.kind === 'assistant' && <div className="copilot-markdown">
        <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={conversationUrl} components={{
          p: ({ children }) => <p>{linkify(children)}</p>,
          li: ({ children }) => <li>{linkify(children)}</li>,
          code: ({ className, children }) => className
            ? <ConversationCode className={className} content={String(children)} />
            : <code>{linkify(children)}</code>,
          img: ({ alt }) => <span className="copilot-tool-note">Image{alt ? ': ' + alt : ' attachment'} (not loaded in this read-only view)</span>,
          a: ({ href, children }) => href ? <a href={href} onClick={event => {
            event.preventDefault();
            if (!href || href.startsWith('#')) return;
            if (/^https?:/i.test(href)) {
              window.agentPlex.openExternal(href).catch(error => {
                console.error('[conversation] Cannot open link:', error);
                onError(String(error));
              });
            } else onOpenFile(href);
          }}>{children}</a> : <span>{children}</span>,
          table: ({ children }) => <div className="copilot-table"><table>{children}</table></div>,
        }}>{text}</ReactMarkdown>
      </div>}
      {entry.kind === 'tool' && <details className="copilot-tool">
        <summary>
          <ChevronRight size={12} className="copilot-tool-chevron" aria-hidden="true" />
          <span>{text}</span>
          {entry.status === 'running' && <LoaderCircle size={12} className="copilot-tool-spinner" aria-label="Running" />}
          {entry.status === 'error' && <span className="copilot-tool-error">Failed</span>}
        </summary>
        {entry.detail
          ? <pre>{stripAnsi(entry.detail)}</pre>
          : <p className="copilot-tool-note">{entry.status === 'running' ? 'Waiting for tool output...' : 'No text output recorded.'}</p>}
      </details>}
    </div>
    {entry.kind === 'user' && time && <time className="copilot-message-time" dateTime={entry.timestamp}>{time}</time>}
  </div>;
});

export function CopilotConversation({ sessionId, active, onOpenFile }: {
  sessionId: string; active: boolean; onOpenFile: (reference: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>(EMPTY_CONVERSATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let hydrated = false;
    const pending: ConversationUpdate[] = [];
    setLoading(true);
    setError('');
    const unsubscribe = window.agentPlex.onConversationData(update => {
      if (update.id !== sessionId || cancelled) return;
      if (!hydrated) pending.push(update);
      else setSnapshot(previous => applyConversationUpdate(previous, update));
    });
    window.agentPlex.getConversationSnapshot(sessionId).then(value => {
      if (cancelled) return;
      let next = value;
      for (const update of pending) next = applyConversationUpdate(next, update);
      pending.length = 0;
      hydrated = true;
      setSnapshot(next);
      setLoading(false);
    }).catch(reason => {
      if (cancelled) return;
      unsubscribe();
      pending.length = 0;
      console.error('[conversation] Cannot load history:', reason);
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [sessionId, active, retry]);

  useLayoutEffect(() => {
    if (active && followRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [snapshot.revision, active, loading]);

  return <section className="copilot-conversation" aria-label="Copilot conversation">
    <div className="copilot-conversation-scroll" ref={scrollRef} tabIndex={0} onScroll={event => {
      const element = event.currentTarget;
      const following = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      followRef.current = following;
      setAtBottom(following);
    }}>
      {error && <div className="copilot-conversation-error" role="alert">
        {error} <button onClick={() => setRetry(value => value + 1)}>Retry</button>
      </div>}
      {loading && <p className="copilot-tool-note">Loading conversation...</p>}
      {!loading && !error && snapshot.entries.length === 0 && <p className="copilot-tool-note">{snapshot.truncated
        ? 'No complete messages fit in this bounded history preview.'
        : 'Waiting for conversation messages...'}</p>}
      {snapshot.truncated && <p className="copilot-tool-note">Showing recent conversation; earlier or oversized content was omitted.</p>}
      {snapshot.entries.map(entry => <ConversationMessage key={entry.key} entry={entry} onOpenFile={onOpenFile} onError={setError} />)}
    </div>
    {!atBottom && <button className="copilot-jump-latest" onClick={() => {
      followRef.current = true;
      setAtBottom(true);
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }}>Jump to latest</button>}
  </section>;
}

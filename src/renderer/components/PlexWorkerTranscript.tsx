import { useEffect, useRef, useState } from 'react';
import type { PlexActivity, PlexTranscript } from '../../shared/plex';

export function PlexWorkerTranscript({ conversationId, agentId, activity = [] }:
  { conversationId: string; agentId: string; activity?: PlexActivity[] }) {
  const [transcript, setTranscript] = useState<PlexTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feed = useRef<HTMLElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (feed.current && follow.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [transcript, activity]);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await window.agentPlex.plexTranscript(conversationId, agentId);
        if (active) { setTranscript(next); setError(null); }
      } catch (error) { if (active) setError(String(error)); }
      finally { if (active) timer = setTimeout(read, 1000); }
    };
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [conversationId, agentId]);
  const entries = new Map((transcript?.entries ?? []).map(entry => [entry.id, entry]));
  activity.forEach(entry => entries.set(entry.id, entry));
  return <section ref={feed} aria-label="Read-only worker conversation"
    className="flex-1 min-h-0 overflow-y-auto border border-border rounded p-2 text-xs space-y-2" onScroll={event => {
      const element = event.currentTarget;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }}>
    <p>Read-only conversation log. Refreshes every second; no input is sent to the worker.</p>
    {error && <p role="alert" className="text-error">{error}</p>}
    {!transcript && !error && <p>Loading conversation...</p>}
    {transcript && !transcript.started && <p>This worker has not started a CLI conversation yet.</p>}
    {transcript?.started && !transcript.entries.length && <p>Waiting for public conversation events...</p>}
    {transcript?.truncated && <p>Showing the latest bounded transcript preview; earlier events remain in the local CLI history.</p>}
    {[...entries.values()].map(entry => <div key={entry.id}>
      <strong>{entry.kind}</strong><pre className="whitespace-pre-wrap break-words">{entry.text}</pre>
    </div>)}
  </section>;
}

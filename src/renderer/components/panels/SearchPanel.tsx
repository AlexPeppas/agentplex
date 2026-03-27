import { useState, useMemo } from 'react';
import { useAppStore } from '../../store';
import { stripAnsi } from '../../../shared/ansi-strip';

const MAX_RESULTS_PER_SESSION = 5;

interface SearchResult {
  sessionId: string;
  sessionLabel: string;
  line: string;
}

export function SearchPanel() {
  const [query, setQuery] = useState('');
  const sessionBuffers = useAppStore((s) => s.sessionBuffers);
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const selectSession = useAppStore((s) => s.selectSession);

  const results = useMemo(() => {
    if (query.length < 2) return [];
    const lowerQuery = query.toLowerCase();
    const matches: SearchResult[] = [];

    for (const [sessionId, buffer] of Object.entries(sessionBuffers)) {
      const session = sessions[sessionId];
      if (!session) continue;
      const label = displayNames[sessionId] || session.title;
      const lines = stripAnsi(buffer).split('\n');
      let count = 0;
      for (const line of lines) {
        if (count >= MAX_RESULTS_PER_SESSION) break;
        const trimmed = line.trim();
        if (trimmed && trimmed.toLowerCase().includes(lowerQuery)) {
          matches.push({ sessionId, sessionLabel: label, line: trimmed });
          count++;
        }
      }
    }
    return matches;
  }, [query, sessionBuffers, sessions, displayNames]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-2">
        <input
          type="text"
          placeholder="Search sessions..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full py-1.5 px-2.5 bg-inset border border-border rounded-md text-fg text-[13px] outline-none transition-colors placeholder:text-fg-muted focus:border-accent"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {query.length >= 2 && results.length === 0 && (
          <div className="p-4 text-center text-fg-muted text-xs">No results</div>
        )}
        {results.map((r, i) => (
          <button
            key={`${r.sessionId}-${i}`}
            onClick={() => selectSession(r.sessionId)}
            className="flex flex-col gap-0.5 w-full px-3.5 py-1.5 text-left hover:bg-elevated transition-colors cursor-pointer"
          >
            <span className="text-fg-muted text-[11px]">{r.sessionLabel}</span>
            <span className="text-fg text-xs truncate">{r.line}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

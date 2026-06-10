import { useState, useMemo, useEffect, useRef } from 'react';
import { useAppStore } from '../../store';
import { stripAnsi } from '../../../shared/ansi-strip';
import type { SessionSearchResult } from '../../../shared/ipc-channels';

const MAX_RESULTS_PER_SESSION = 5;
const SEARCH_DEBOUNCE_MS = 250;

interface OpenResult {
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
  const addSession = useAppStore((s) => s.addSession);

  // ── Instant in-memory search over currently open sessions ───────────────────
  const openResults = useMemo<OpenResult[]>(() => {
    if (query.length < 2) return [];
    const lowerQuery = query.toLowerCase();
    const matches: OpenResult[] = [];

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

  // ── Debounced disk-history search across ALL sessions (Phase 1) ─────────────
  const [history, setHistory] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHistory([]);
      setSearching(false);
      return;
    }
    const id = ++reqId.current;
    setSearching(true);
    const handle = setTimeout(async () => {
      try {
        const results = await window.agentPlex.searchSessions(q);
        // Ignore stale responses from earlier keystrokes.
        if (reqId.current === id) setHistory(results);
      } catch (err) {
        console.error('History search failed:', err);
        if (reqId.current === id) setHistory([]);
      } finally {
        if (reqId.current === id) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [query]);

  const handleHistoryClick = async (r: SessionSearchResult) => {
    try {
      const info = await window.agentPlex.createSession(r.projectPath, r.cli, r.sessionId);
      addSession(info);
    } catch (err) {
      console.error('Failed to resume session from search:', err);
    }
  };

  const hasQuery = query.length >= 2;
  const noResults = hasQuery && !searching && openResults.length === 0 && history.length === 0;

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
        {noResults && (
          <div className="p-4 text-center text-fg-muted text-xs">No results</div>
        )}

        {openResults.length > 0 && (
          <>
            <div className="px-3.5 py-1 text-fg-muted text-[10px] uppercase tracking-wide">Open sessions</div>
            {openResults.map((r, i) => (
              <button
                key={`open-${r.sessionId}-${i}`}
                onClick={() => selectSession(r.sessionId, true)}
                className="flex flex-col gap-0.5 w-full px-3.5 py-1.5 text-left hover:bg-elevated transition-colors cursor-pointer"
              >
                <span className="text-fg-muted text-[11px]">{r.sessionLabel}</span>
                <span className="text-fg text-xs truncate">{r.line}</span>
              </button>
            ))}
          </>
        )}

        {hasQuery && (
          <div className="px-3.5 py-1 text-fg-muted text-[10px] uppercase tracking-wide flex items-center gap-1.5">
            <span>History</span>
            {searching && <span className="text-fg-muted normal-case tracking-normal">searching…</span>}
          </div>
        )}
        {history.map((r, i) => (
          <button
            key={`hist-${r.cli}-${r.sessionId}-${i}`}
            onClick={() => handleHistoryClick(r)}
            title={`${r.projectPath} · resume ${r.cli} session`}
            className="flex flex-col gap-0.5 w-full px-3.5 py-1.5 text-left hover:bg-elevated transition-colors cursor-pointer"
          >
            <span className="text-fg-muted text-[11px] flex items-center gap-1.5">
              <span className="uppercase text-[9px] px-1 py-px rounded bg-inset border border-border">{r.cli}</span>
              <span className="truncate">{r.projectName}</span>
            </span>
            <span className="text-fg text-xs truncate">{r.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

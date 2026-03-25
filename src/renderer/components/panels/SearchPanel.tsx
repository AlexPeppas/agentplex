import { useState, useMemo, useCallback, useRef } from 'react';
import { useAppStore } from '../../store';
import { stripAnsi } from '../../../shared/ansi-strip';

type SearchMode = 'sessions' | 'files';

interface FileResult {
  file: string;
  line: number;
  text: string;
}

export function SearchPanel() {
  const [mode, setMode] = useState<SearchMode>('sessions');
  const [query, setQuery] = useState('');
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [searching, setSearching] = useState(false);
  const sessionBuffers = useAppStore((s) => s.sessionBuffers);
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const selectSession = useAppStore((s) => s.selectSession);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const sessionResults = useMemo(() => {
    if (!query || query.length < 2 || mode !== 'sessions') return [];
    const results: { sessionId: string; label: string; matches: string[] }[] = [];
    const q = query.toLowerCase();

    for (const [id, buffer] of Object.entries(sessionBuffers)) {
      const clean = stripAnsi(buffer);
      const lines = clean.split('\n');
      const matches: string[] = [];
      for (const line of lines) {
        if (matches.length >= 5) break;
        if (line.toLowerCase().includes(q)) {
          matches.push(line.trim().slice(0, 200));
        }
      }
      if (matches.length > 0) {
        results.push({
          sessionId: id,
          label: displayNames[id] || sessions[id]?.title || id,
          matches,
        });
      }
    }
    return results;
  }, [query, sessionBuffers, sessions, displayNames, mode]);

  const handleFileSearch = useCallback((q: string) => {
    if (q.length < 2) {
      setFileResults([]);
      return;
    }
    setSearching(true);
    // Search across all unique cwds
    const cwds = new Set(Object.values(sessions).map((s) => s.cwd).filter(Boolean));
    const promises = Array.from(cwds).map((cwd) => window.agentPlex.searchFiles(q, cwd));
    Promise.all(promises).then((results) => {
      setFileResults(results.flat().slice(0, 100));
      setSearching(false);
    }).catch(() => {
      setSearching(false);
    });
  }, [sessions]);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    if (mode === 'files') {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => handleFileSearch(value), 300);
    }
  };

  const handleModeChange = (newMode: SearchMode) => {
    setMode(newMode);
    if (newMode === 'files' && query.length >= 2) {
      handleFileSearch(query);
    }
  };

  return (
    <div className="search-panel">
      <div className="search-panel__tabs">
        <button
          className={`search-panel__tab ${mode === 'sessions' ? 'search-panel__tab--active' : ''}`}
          onClick={() => handleModeChange('sessions')}
        >
          Sessions
        </button>
        <button
          className={`search-panel__tab ${mode === 'files' ? 'search-panel__tab--active' : ''}`}
          onClick={() => handleModeChange('files')}
        >
          Files
        </button>
      </div>

      <div className="search-panel__input-wrapper">
        <input
          className="search-panel__input"
          type="text"
          placeholder={mode === 'sessions' ? 'Search session output...' : 'Search file contents...'}
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
        />
      </div>

      <div className="search-panel__results">
        {query.length < 2 && (
          <div className="panel-empty">Type at least 2 characters to search</div>
        )}

        {mode === 'sessions' && sessionResults.map((r) => (
          <div key={r.sessionId}>
            {r.matches.map((match, i) => (
              <div
                key={`${r.sessionId}-${i}`}
                className="search-result"
                onClick={() => selectSession(r.sessionId)}
              >
                <span className="search-result__source">{r.label}</span>
                <span className="search-result__match">{match}</span>
              </div>
            ))}
          </div>
        ))}

        {mode === 'files' && searching && (
          <div className="panel-empty">Searching...</div>
        )}

        {mode === 'files' && !searching && query.length >= 2 && fileResults.length === 0 && (
          <div className="panel-empty">No matches found</div>
        )}

        {mode === 'files' && !searching && fileResults.map((r, i) => (
          <div key={`${r.file}-${r.line}-${i}`} className="search-result">
            <span className="search-result__source">{r.file}:{r.line}</span>
            <span className="search-result__match">{r.text}</span>
          </div>
        ))}

        {mode === 'sessions' && query.length >= 2 && sessionResults.length === 0 && (
          <div className="panel-empty">No matches found</div>
        )}
      </div>
    </div>
  );
}

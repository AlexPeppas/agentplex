import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, RefreshCw } from 'lucide-react';
import type { WorkspaceDirectory } from '../../shared/ipc-channels';

interface Props {
  sessionId: string;
  cwd: string;
  onOpenFile: (reference: string) => void;
}

function Directory({ sessionId, cwd, directory, label, onOpenFile, root = false }: Props & {
  directory: string; label: string; root?: boolean;
}) {
  const [expanded, setExpanded] = useState(root);
  const [result, setResult] = useState<WorkspaceDirectory | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setResult(null);
    setError('');
    window.agentPlex.listWorkspaceDirectory(sessionId, directory)
      .then(value => { if (!cancelled) setResult(value); })
      .catch(reason => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); });
    return () => { cancelled = true; };
  }, [sessionId, cwd, directory, expanded, revision]);
  return (
    <div>
      <div className="flex items-center">
        <button className="flex items-center gap-1 py-1 min-w-0 text-left flex-1 hover:bg-hover" onClick={() => setExpanded(!expanded)} title={directory || cwd} aria-expanded={expanded}>
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Folder size={12} className="shrink-0" /><span className="truncate">{label}</span>
        </button>
        {root && <button title="Refresh workspace files" aria-label="Refresh workspace files" onClick={() => setRevision(revision + 1)}><RefreshCw size={12} /></button>}
      </div>
      {expanded && (
        <div className="pl-3">
          {!result && !error && <div className="text-fg-muted py-1">Loading...</div>}
          {error && <div role="alert" className="text-red-400 break-words py-1">{error}<button className="block underline" onClick={() => setRevision(revision + 1)}>Retry</button></div>}
          {result?.entries.map(entry => entry.directory && !entry.blocked
            ? <Directory key={`${revision}:${entry.path}`} sessionId={sessionId} cwd={cwd} directory={entry.path} label={entry.name} onOpenFile={onOpenFile} />
            : <button key={entry.path} disabled={entry.blocked} title={entry.blocked ? 'Unavailable link or outside this workspace' : entry.path}
              className="flex items-center gap-1 py-1 w-full min-w-0 text-left hover:bg-hover disabled:opacity-40"
              onClick={() => onOpenFile(entry.path)}><File size={12} className="shrink-0" /><span className="truncate">{entry.name}</span></button>)}
          {result?.entries.length === 0 && <div className="text-fg-muted py-1">Empty directory</div>}
          {result?.truncated && <div className="text-fg-muted py-1">Only the first 500 entries are shown.</div>}
        </div>
      )}
    </div>
  );
}

export function WorkspaceExplorer(props: Props) {
  return (
    <aside aria-label="Workspace files" className="shrink-0 border-r border-border bg-surface text-fg text-xs p-2 overflow-auto"
      style={{ width: 220, minWidth: 140, maxWidth: '45%', resize: 'horizontal' }}>
      <div className="font-semibold text-fg-muted mb-1">WORKSPACE</div>
      <Directory key={`${props.sessionId}:${props.cwd}`} {...props} directory="" label={props.cwd.split(/[\\/]/).filter(Boolean).pop() || props.cwd} root />
    </aside>
  );
}

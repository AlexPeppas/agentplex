import { useState, useCallback } from 'react';
import { DiffEditor, loader } from '@monaco-editor/react';
import { X, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { useAppStore } from '../store';
import type { SyncConflictFile } from '../../shared/ipc-channels';

loader.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });

interface Props {
  conflicts: SyncConflictFile[];
  onClose: () => void;
}

export function SyncConflictDialog({ conflicts, onClose }: Props) {
  const updateSyncStatus = useAppStore((s) => s.updateSyncStatus);
  const [index, setIndex] = useState(0);
  const [resolutions, setResolutions] = useState<Record<string, { resolution: 'ours' | 'theirs' | 'manual'; content?: string }>>({});
  const [resolving, setResolving] = useState(false);

  const current = conflicts[index];
  const allResolved = conflicts.every((c) => resolutions[c.path]);

  const handleKeepMine = useCallback(() => {
    setResolutions((r) => ({ ...r, [current.path]: { resolution: 'ours' } }));
  }, [current]);

  const handleKeepTheirs = useCallback(() => {
    setResolutions((r) => ({ ...r, [current.path]: { resolution: 'theirs' } }));
  }, [current]);

  const handleResolveAll = useCallback(async () => {
    setResolving(true);
    try {
      for (const conflict of conflicts) {
        const res = resolutions[conflict.path];
        if (!res) continue;
        // For now, resolve via individual calls. Could batch in future.
        // The sync engine auto-commits+pushes after all conflicts are resolved.
        await (window as any).agentPlex.syncResolveConflict?.({
          path: conflict.path,
          resolution: res.resolution,
          manualContent: res.content,
        });
      }
      const status = await window.agentPlex.syncStatus();
      updateSyncStatus(status);
      onClose();
    } catch (err: any) {
      console.error('[sync-conflict] resolve error:', err);
    } finally {
      setResolving(false);
    }
  }, [conflicts, resolutions, updateSyncStatus, onClose]);

  if (!current) return null;

  const resolved = resolutions[current.path];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-surface border border-border rounded-lg shadow-xl w-[90vw] max-w-5xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-fg">Sync Conflicts</h2>
            <span className="text-xs text-fg-muted">
              {index + 1} / {conflicts.length}
            </span>
          </div>
          <button onClick={onClose} className="text-fg-muted hover:text-fg p-1 rounded">
            <X size={16} />
          </button>
        </div>

        {/* File name */}
        <div className="px-4 py-2 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setIndex(Math.max(0, index - 1))}
              disabled={index === 0}
              className="text-fg-muted hover:text-fg disabled:opacity-30 p-0.5"
            >
              <ChevronLeft size={14} />
            </button>
            <span className="text-xs text-fg font-mono">{current.path}</span>
            <button
              onClick={() => setIndex(Math.min(conflicts.length - 1, index + 1))}
              disabled={index === conflicts.length - 1}
              className="text-fg-muted hover:text-fg disabled:opacity-30 p-0.5"
            >
              <ChevronRight size={14} />
            </button>
          </div>
          {resolved && (
            <span className="text-xs text-green-400 flex items-center gap-1">
              <Check size={12} />
              {resolved.resolution === 'ours' ? 'Keeping yours' : resolved.resolution === 'theirs' ? 'Keeping theirs' : 'Manual edit'}
            </span>
          )}
        </div>

        {/* Diff editor */}
        <div className="flex-1 min-h-0">
          <DiffEditor
            original={current.ours}
            modified={current.theirs}
            language={current.language}
            theme="vs-dark"
            options={{
              readOnly: false,
              renderSideBySide: true,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
            }}
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <div className="flex gap-2">
            <span className="text-xs text-fg-muted mr-2 self-center">Local (left) vs Remote (right)</span>
            <button
              onClick={handleKeepMine}
              className="px-3 py-1.5 text-xs rounded bg-elevated text-fg-muted hover:text-fg hover:bg-surface transition-colors"
            >
              Keep Mine
            </button>
            <button
              onClick={handleKeepTheirs}
              className="px-3 py-1.5 text-xs rounded bg-elevated text-fg-muted hover:text-fg hover:bg-surface transition-colors"
            >
              Keep Theirs
            </button>
          </div>
          <button
            onClick={handleResolveAll}
            disabled={!allResolved || resolving}
            className="px-4 py-1.5 text-xs rounded bg-accent text-fg font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {resolving ? 'Resolving...' : `Resolve All (${Object.keys(resolutions).length}/${conflicts.length})`}
          </button>
        </div>
      </div>
    </div>
  );
}

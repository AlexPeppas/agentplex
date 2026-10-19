import { useState, useEffect, useRef, useCallback } from 'react';
import { DiffEditor, loader } from '@monaco-editor/react';
import type { DiffEditorProps } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { RefreshCw, Save, Plus, Minus, GitCommit, ArrowUp, ArrowDown, ChevronDown, ChevronRight } from 'lucide-react';
import type { GitChangedFile, GitFileDiffResult, GitLogEntry, GitBranchInfo } from '../../shared/ipc-channels';

// Configure Monaco to load from node_modules (works offline in Electron)
loader.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--warning)',
  A: 'var(--success)',
  D: 'var(--error)',
  R: 'var(--accent)',
  U: 'var(--warning)',
  '?': 'var(--text-muted)',
};

const STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  U: 'Unmerged',
  '?': 'Untracked',
};

interface Props {
  sessionId: string;
}

function OwnedDiffEditor(props: DiffEditorProps) {
  const instanceRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => () => {
    const instance = instanceRef.current;
    const models = instance?.getModel();
    // Detach first: Monaco 0.55 rejects disposal while a diff widget owns the models.
    instance?.setModel(null);
    models?.original.dispose();
    models?.modified.dispose();
    instanceRef.current = null;
  }, []);
  return <DiffEditor {...props} onMount={(instance, monaco) => {
    instanceRef.current = instance;
    props.onMount?.(instance, monaco);
  }} />;
}

export function GitDiffPanel({ sessionId }: Props) {
  const [files, setFiles] = useState<GitChangedFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<(GitFileDiffResult & { sessionId: string; filePath: string; staged: boolean }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isModified, setIsModified] = useState(false);
  const editorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const currentSessionRef = useRef(sessionId);
  const [editorFontSize, setEditorFontSize] = useState(13);
  const activeDiff = diff?.sessionId === sessionId && diff.filePath === selectedFile?.path &&
    diff.staged === selectedFile?.staged ? diff : null;

  // Commit state
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [cmdOutput, setCmdOutput] = useState<{ text: string; success: boolean } | null>(null);

  // Branch & log state
  const [branchInfo, setBranchInfo] = useState<GitBranchInfo | null>(null);
  const [logEntries, setLogEntries] = useState<GitLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  // Track session changes to avoid stale requests
  useEffect(() => {
    currentSessionRef.current = sessionId;
  }, [sessionId]);

  const refreshFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await window.agentPlex.gitStatus(sessionId);
      if (currentSessionRef.current !== sessionId) return;
      if (!status.isRepo) {
        setError('Not a git repository');
        setFiles([]);
        return;
      }
      setFiles(status.files);
      // If the currently selected file is no longer in the list, deselect
      if (selectedFile && !status.files.some(f => f.path === selectedFile.path && f.staged === selectedFile.staged)) {
        setSelectedFile(null);
        setDiff(null);
      }
    } catch (err: any) {
      if (currentSessionRef.current === sessionId) {
        setError(err.message || 'Failed to get git status');
      }
    } finally {
      if (currentSessionRef.current === sessionId) {
        setLoading(false);
      }
    }
  }, [sessionId, selectedFile]);

  const refreshBranchInfo = useCallback(async () => {
    try {
      const info = await window.agentPlex.gitBranchInfo(sessionId);
      if (currentSessionRef.current === sessionId) setBranchInfo(info);
    } catch { /* ignore */ }
  }, [sessionId]);

  const refreshLog = useCallback(async () => {
    try {
      const entries = await window.agentPlex.gitLog(sessionId);
      if (currentSessionRef.current === sessionId) setLogEntries(entries);
    } catch { /* ignore */ }
  }, [sessionId]);

  // Load files on mount and when session changes
  useEffect(() => {
    refreshFiles();
    refreshBranchInfo();
  }, [sessionId, refreshFiles, refreshBranchInfo]);

  // Load diff when file is selected
  useEffect(() => {
    if (!selectedFile) {
      setDiff(null);
      return;
    }
    let cancelled = false;
    const { path: filePath, staged } = selectedFile;
    (async () => {
      try {
        const result = await window.agentPlex.gitFileDiff(sessionId, filePath, staged);
        if (!cancelled) {
          setDiff({ ...result, sessionId, filePath, staged });
          setIsModified(false);
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || 'Failed to load diff');
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, selectedFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile || !activeDiff || !editorRef.current || selectedFile.staged) return;
    const savingEditor = editorRef.current;
    const modifiedEditor = savingEditor.getModifiedEditor();
    const content = modifiedEditor.getValue();
    setSaving(true);
    try {
      await window.agentPlex.gitSaveFile(sessionId, selectedFile.path, content);
      if (editorRef.current === savingEditor) setIsModified(false);
      refreshFiles();
    } catch (err: any) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [sessionId, selectedFile, activeDiff, refreshFiles]);

  const handleStage = useCallback(async (filePath: string) => {
    try {
      await window.agentPlex.gitStageFile(sessionId, filePath);
      refreshFiles();
    } catch (err: any) {
      setError(err.message || 'Failed to stage file');
    }
  }, [sessionId, refreshFiles]);

  const handleUnstage = useCallback(async (filePath: string) => {
    try {
      await window.agentPlex.gitUnstageFile(sessionId, filePath);
      refreshFiles();
    } catch (err: any) {
      setError(err.message || 'Failed to unstage file');
    }
  }, [sessionId, refreshFiles]);

  const handleStageAll = useCallback(async () => {
    try {
      await window.agentPlex.gitStageAll(sessionId);
      refreshFiles();
    } catch (err: any) {
      setError(err.message || 'Failed to stage all');
    }
  }, [sessionId, refreshFiles]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await window.agentPlex.gitUnstageAll(sessionId);
      refreshFiles();
    } catch (err: any) {
      setError(err.message || 'Failed to unstage all');
    }
  }, [sessionId, refreshFiles]);

  const handleCommit = useCallback(async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    setCmdOutput(null);
    try {
      const result = await window.agentPlex.gitCommit(sessionId, commitMsg.trim());
      setCmdOutput({ text: result.output, success: result.success });
      if (result.success) {
        setCommitMsg('');
        refreshFiles();
        refreshBranchInfo();
        refreshLog();
      }
    } catch (err: any) {
      setCmdOutput({ text: err.message || 'Commit failed', success: false });
    } finally {
      setCommitting(false);
    }
  }, [sessionId, commitMsg, refreshFiles, refreshBranchInfo, refreshLog]);

  const handlePush = useCallback(async () => {
    setPushing(true);
    setCmdOutput(null);
    try {
      const result = await window.agentPlex.gitPush(sessionId);
      setCmdOutput({ text: result.output, success: result.success });
      if (result.success) refreshBranchInfo();
    } catch (err: any) {
      setCmdOutput({ text: err.message || 'Push failed', success: false });
    } finally {
      setPushing(false);
    }
  }, [sessionId, refreshBranchInfo]);

  const handlePull = useCallback(async () => {
    setPulling(true);
    setCmdOutput(null);
    try {
      const result = await window.agentPlex.gitPull(sessionId);
      setCmdOutput({ text: result.output, success: result.success });
      if (result.success) {
        refreshFiles();
        refreshBranchInfo();
        refreshLog();
      }
    } catch (err: any) {
      setCmdOutput({ text: err.message || 'Pull failed', success: false });
    } finally {
      setPulling(false);
    }
  }, [sessionId, refreshFiles, refreshBranchInfo, refreshLog]);

  const handleEditorMount = useCallback((editor: editor.IStandaloneDiffEditor) => {
    editorRef.current = editor;
    // Track modifications
    const modifiedEditor = editor.getModifiedEditor();
    modifiedEditor.onDidChangeModelContent(() => {
      setIsModified(true);
    });
    // Ctrl+S to save (KeyMod.CtrlCmd | KeyCode.KeyS)
    modifiedEditor.addCommand(
      2097, // 2048 + 49
      () => handleSave(),
    );
  }, [handleSave]);

  // Sync font size to editor when it changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.getOriginalEditor().updateOptions({ fontSize: editorFontSize });
      editorRef.current.getModifiedEditor().updateOptions({ fontSize: editorFontSize });
    }
  }, [editorFontSize]);

  // Ctrl+=/Ctrl+-/Ctrl+0 zoom via main process menu accelerator
  useEffect(() => {
    return window.agentPlex.onZoom((direction) => {
      if (direction === 'in') setEditorFontSize((s) => Math.min(s + 2, 32));
      else if (direction === 'out') setEditorFontSize((s) => Math.max(s - 2, 8));
      else if (direction === 'reset') setEditorFontSize(13);
    });
  }, []);

  const handleToggleLog = useCallback(() => {
    if (!logOpen) refreshLog();
    setLogOpen((v) => !v);
  }, [logOpen, refreshLog]);

  // Group files by staged/unstaged
  const stagedFiles = files.filter(f => f.staged);
  const unstagedFiles = files.filter(f => !f.staged);
  const isBusy = committing || pushing || pulling;

  const renderFileEntry = (file: GitChangedFile) => {
    const isSelected = selectedFile?.path === file.path && selectedFile?.staged === file.staged;
    const parts = file.path.split('/');
    const basename = parts.pop() || file.path;
    const dirname = parts.length > 0 ? parts.join('/') + '/' : '';

    return (
      <div
        key={`${file.staged ? 's' : 'u'}-${file.path}`}
        className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer rounded text-xs group ${
          isSelected
            ? 'bg-accent-subtle text-fg'
            : 'text-fg-muted hover:bg-accent-subtle hover:text-fg'
        }`}
        onClick={() => setSelectedFile({ path: file.path, staged: file.staged })}
      >
        <span
          className="shrink-0 w-4 text-center font-bold text-[10px]"
          style={{ color: STATUS_COLORS[file.status] || 'var(--text-muted)' }}
          title={STATUS_LABELS[file.status] || file.status}
        >
          {file.status}
        </span>
        <span className="truncate flex-1 min-w-0">
          <span className="text-fg-muted">{dirname}</span>
          <span className="font-medium">{basename}</span>
        </span>
        {/* Stage/unstage button */}
        <button
          className="shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 p-0.5 rounded hover:bg-accent-subtle text-fg-muted hover:text-fg"
          onClick={(e) => {
            e.stopPropagation();
            if (file.staged) {
              handleUnstage(file.path);
            } else {
              handleStage(file.path);
            }
          }}
          title={file.staged ? 'Unstage' : 'Stage'}
        >
          {file.staged ? <Minus size={12} /> : <Plus size={12} />}
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full bg-surface">
      {/* File list sidebar */}
      <div className="w-56 shrink-0 border-r border-border flex flex-col overflow-hidden">
        {/* Branch info bar */}
        {branchInfo && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border text-[11px]">
            <span className="text-accent font-medium truncate">{branchInfo.current}</span>
            {branchInfo.tracking && (
              <span className="text-fg-muted shrink-0">
                {branchInfo.ahead > 0 && <span className="text-success">{'\u2191'}{branchInfo.ahead}</span>}
                {branchInfo.behind > 0 && <span className="text-warning ml-0.5">{'\u2193'}{branchInfo.behind}</span>}
                {branchInfo.ahead === 0 && branchInfo.behind === 0 && <span>{'\u2713'}</span>}
              </span>
            )}
            {!branchInfo.tracking && (
              <span className="text-fg-muted shrink-0 text-[10px]">no upstream</span>
            )}
          </div>
        )}

        {/* Changes header */}
        <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
          <span className="text-xs font-medium text-fg-muted">Changes</span>
          <div className="flex items-center gap-0.5">
            <button
              className="p-0.5 rounded text-fg-muted hover:bg-accent-subtle hover:text-fg"
              onClick={refreshFiles}
              title="Refresh"
            >
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto py-1">
          {error && (
            <div className="px-2 py-1 text-xs text-error">{error}</div>
          )}
          {files.length === 0 && !error && !loading && (
            <div className="px-2 py-3 text-xs text-fg-muted text-center">
              No changes
            </div>
          )}
          {stagedFiles.length > 0 && (
            <>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider">
                  Staged
                </span>
                <button
                  className="p-0.5 rounded text-fg-muted hover:bg-accent-subtle hover:text-fg"
                  onClick={handleUnstageAll}
                  title="Unstage all"
                >
                  <Minus size={12} />
                </button>
              </div>
              {stagedFiles.map(renderFileEntry)}
            </>
          )}
          {unstagedFiles.length > 0 && (
            <>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider">
                  {stagedFiles.length > 0 ? 'Unstaged' : 'Changes'}
                </span>
                <button
                  className="p-0.5 rounded text-fg-muted hover:bg-accent-subtle hover:text-fg"
                  onClick={handleStageAll}
                  title="Stage all"
                >
                  <Plus size={12} />
                </button>
              </div>
              {unstagedFiles.map(renderFileEntry)}
            </>
          )}
        </div>

        {/* Commit / push / pull section */}
        <div className="border-t border-border p-2 flex flex-col gap-1.5">
          {/* Commit message input */}
          <textarea
            className="w-full bg-inset border border-border rounded px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted resize-none outline-none focus:border-accent"
            rows={2}
            placeholder="Commit message..."
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                handleCommit();
              }
            }}
          />

          {/* Commit button */}
          <button
            className={`flex items-center justify-center gap-1.5 w-full px-2 py-1 rounded text-xs font-medium transition-colors ${
              stagedFiles.length > 0 && commitMsg.trim() && !isBusy
                ? 'bg-accent-subtle text-accent hover:bg-accent-subtle-strong'
                : 'bg-inset text-fg-muted cursor-default'
            }`}
            onClick={handleCommit}
            disabled={stagedFiles.length === 0 || !commitMsg.trim() || isBusy}
            title="Commit staged changes (Ctrl+Enter)"
          >
            <GitCommit size={12} />
            {committing ? 'Committing...' : `Commit (${stagedFiles.length})`}
          </button>

          {/* Push / Pull row */}
          <div className="flex gap-1">
            <button
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                !isBusy
                  ? 'bg-inset text-fg-muted hover:bg-accent-subtle hover:text-fg'
                  : 'bg-inset text-fg-muted cursor-default'
              }`}
              onClick={handlePull}
              disabled={isBusy}
              title="Pull from remote"
            >
              <ArrowDown size={12} />
              {pulling ? 'Pulling...' : 'Pull'}
            </button>
            <button
              className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                !isBusy
                  ? 'bg-inset text-fg-muted hover:bg-accent-subtle hover:text-fg'
                  : 'bg-inset text-fg-muted cursor-default'
              }`}
              onClick={handlePush}
              disabled={isBusy}
              title="Push to remote"
            >
              <ArrowUp size={12} />
              {pushing ? 'Pushing...' : 'Push'}
            </button>
          </div>

          {/* Command output */}
          {cmdOutput && (
            <div className={`px-2 py-1 rounded text-[10px] leading-snug break-words max-h-16 overflow-y-auto ${
              cmdOutput.success ? 'bg-success/10 text-success' : 'bg-error-subtle text-error'
            }`}>
              {cmdOutput.text}
            </div>
          )}
        </div>

        {/* Log section (collapsible) */}
        <div className="border-t border-border">
          <button
            className="flex items-center gap-1 w-full px-2 py-1.5 text-xs text-fg-muted hover:text-fg"
            onClick={handleToggleLog}
          >
            {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span className="font-medium">Log</span>
          </button>
          {logOpen && (
            <div className="max-h-32 overflow-y-auto pb-1">
              {logEntries.length === 0 && (
                <div className="px-2 py-1 text-[10px] text-fg-muted">No commits</div>
              )}
              {logEntries.map((entry) => (
                <div key={entry.hash} className="px-2 py-0.5 text-[10px] leading-relaxed hover:bg-accent-subtle rounded mx-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-accent font-mono shrink-0">{entry.shortHash}</span>
                    <span className="text-fg truncate">{entry.subject}</span>
                  </div>
                  <div className="text-fg-muted">
                    {entry.author} {'\u00b7'} {entry.date}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Diff editor area */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedFile && (
          <div className="flex items-center justify-between px-3 py-1 border-b border-border bg-surface">
            <span className="text-xs text-fg-muted truncate">
              {selectedFile.path}
              {selectedFile.staged && <span className="ml-1.5 text-[10px] text-success">(staged)</span>}
              {isModified && <span className="ml-1.5 text-warning">*</span>}
            </span>
            {!selectedFile.staged && (
              <button
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                  isModified
                    ? 'bg-accent-subtle text-accent hover:bg-accent-subtle-strong'
                    : 'text-fg-muted cursor-default'
                }`}
                onClick={handleSave}
                disabled={!activeDiff || !isModified || saving}
                title="Save (Ctrl+S)"
              >
                <Save size={12} />
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        )}
        <div className="flex-1 min-h-0">
          {!selectedFile && (
            <div className="flex items-center justify-center h-full text-sm text-fg-muted">
              Select a file to view diff
            </div>
          )}
          {selectedFile && activeDiff && (
            <OwnedDiffEditor
              key={`${sessionId}:${selectedFile.staged}:${selectedFile.path}`}
              original={activeDiff.original}
              modified={activeDiff.modified}
              language={activeDiff.language}
              theme="agentplex-dark"
              onMount={handleEditorMount}
              options={{
                readOnly: selectedFile.staged,
                originalEditable: false,
                renderSideBySide: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: editorFontSize,
                fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
                lineNumbers: 'on',
                glyphMargin: false,
                folding: true,
                renderWhitespace: 'selection',
                contextmenu: true,
              }}
            />
          )}
          {selectedFile && !activeDiff && !error && (
            <div className="flex items-center justify-center h-full text-sm text-fg-muted">
              Loading...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

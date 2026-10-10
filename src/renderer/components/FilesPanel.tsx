import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Editor, loader } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import {
  Folder,
  FolderOpen,
  File,
  FileText,
  FileCode,
  Image as ImageIcon,
  RefreshCw,
  Save,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  X,
  Search,
  RotateCcw,
  AlertCircle,
  FolderTree,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import type { FileItem, FileContentResult } from '../../shared/ipc-channels';
import { useCurrentTheme } from '../hooks/useTheme';
import { defineAgentPlexTheme } from '../monaco-theme';

loader.config({ paths: { vs: 'node_modules/monaco-editor/min/vs' } });

let themesInitialized = false;

interface Props {
  sessionId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(item: FileItem) {
  if (item.isDirectory) {
    return null;
  }
  const ext = item.extension || '';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp'].includes(ext)) {
    return <ImageIcon size={13} className="shrink-0 text-success opacity-85" />;
  }
  if (['.ts', '.tsx', '.js', '.jsx', '.json', '.html', '.css', '.scss', '.py', '.rs', '.go', '.c', '.cpp', '.cs', '.sh', '.yaml', '.yml', '.sql'].includes(ext)) {
    return <FileCode size={13} className="shrink-0 text-accent opacity-90" />;
  }
  if (['.md', '.txt', '.log', '.env', '.gitignore'].includes(ext) || item.name.startsWith('.')) {
    return <FileText size={13} className="shrink-0 text-fg-muted" />;
  }
  return <File size={13} className="shrink-0 text-fg-muted opacity-80" />;
}

export function FilesPanel({ sessionId }: Props) {
  const currentTheme = useCurrentTheme();
  const [folderContents, setFolderContents] = useState<Record<string, FileItem[]>>({});
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['']));
  const [loadingFolders, setLoadingFolders] = useState<Set<string>>(new Set());
  const [selectedFilePath, setSelectedFilePathState] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(`agentplex:selectedFile:${sessionId}`) || null;
    } catch {
      return null;
    }
  });

  const setSelectedFilePath = useCallback((filePath: string | null) => {
    setSelectedFilePathState(filePath);
    try {
      if (filePath) {
        sessionStorage.setItem(`agentplex:selectedFile:${sessionId}`, filePath);
      } else {
        sessionStorage.removeItem(`agentplex:selectedFile:${sessionId}`);
      }
    } catch {
      // ignore
    }
  }, [sessionId]);
  const [fileData, setFileData] = useState<FileContentResult | null>(null);
  const [editorContent, setEditorContent] = useState<string>('');
  const [isModified, setIsModified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState('');
  const [editorFontSize, setEditorFontSize] = useState(13);
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // New item creation state
  const [creatingType, setCreatingType] = useState<'file' | 'folder' | null>(null);
  const [creatingInPath, setCreatingInPath] = useState<string>('');
  const [newItemName, setNewItemName] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const currentSessionRef = useRef(sessionId);

  useEffect(() => {
    currentSessionRef.current = sessionId;
  }, [sessionId]);

  // Ensure Monaco themes are registered
  useEffect(() => {
    if (!themesInitialized) {
      themesInitialized = true;
      defineAgentPlexTheme();
    }
  }, []);

  // Fetch children of a given directory relative to session root
  const fetchDirectory = useCallback(async (dirPath: string = '', silent = false) => {
    if (!silent) {
      setLoadingFolders((prev) => new Set(prev).add(dirPath));
    }
    setError(null);
    try {
      const items = await window.agentPlex.listFiles(sessionId, dirPath);
      if (currentSessionRef.current !== sessionId) return;
      setFolderContents((prev) => ({ ...prev, [dirPath]: items }));
    } catch (err: any) {
      if (currentSessionRef.current === sessionId) {
        setError(err.message || `Failed to read directory: ${dirPath}`);
      }
    } finally {
      if (currentSessionRef.current === sessionId && !silent) {
        setLoadingFolders((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        });
      }
    }
  }, [sessionId]);

  // Load a file into editor
  const loadFile = useCallback(async (filePath: string) => {
    setLoadingFile(true);
    setError(null);
    try {
      const result = await window.agentPlex.readFile(sessionId, filePath);
      if (currentSessionRef.current !== sessionId) return;
      setFileData(result);
      setEditorContent(result.content ?? '');
      setIsModified(false);
    } catch (err: any) {
      if (currentSessionRef.current === sessionId) {
        setError(err.message || `Failed to open ${filePath}`);
      }
    } finally {
      if (currentSessionRef.current === sessionId) {
        setLoadingFile(false);
      }
    }
  }, [sessionId]);

  // Initial load: root directory
  useEffect(() => {
    setFolderContents({});
    setExpandedFolders(new Set(['']));
    setLoadingFolders(new Set());
    fetchDirectory('');
    // Restore selected file if available
    try {
      const savedPath = sessionStorage.getItem(`agentplex:selectedFile:${sessionId}`);
      if (savedPath) {
        loadFile(savedPath);
      } else {
        setSelectedFilePath(null);
        setPendingFilePath(null);
        setFileData(null);
        setEditorContent('');
        setIsModified(false);
      }
    } catch {
      setSelectedFilePath(null);
      setPendingFilePath(null);
      setFileData(null);
      setEditorContent('');
      setIsModified(false);
    }
  }, [sessionId, fetchDirectory, loadFile, setSelectedFilePath]);

  // Toggle expand / collapse folder
  const toggleFolder = useCallback(async (folderPath: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) {
        next.delete(folderPath);
      } else {
        next.add(folderPath);
        // Load children if not yet cached
        if (!folderContents[folderPath]) {
          fetchDirectory(folderPath);
        }
      }
      return next;
    });
  }, [folderContents, fetchDirectory]);

  // Collapse all
  const collapseAll = useCallback(() => {
    setExpandedFolders(new Set(['']));
  }, []);



  // Refresh all currently expanded folders
  const refreshAll = useCallback(async () => {
    const paths = Array.from(expandedFolders);
    await Promise.all(paths.map((p) => fetchDirectory(p, true)));
    // If a file is selected and not modified, reload it
    if (selectedFilePath && !isModified) {
      loadFile(selectedFilePath);
    }
  }, [expandedFolders, fetchDirectory, selectedFilePath, isModified, loadFile]);

  // Handle save
  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!selectedFilePath || !editorRef.current || saving) return false;
    const content = editorRef.current.getValue();
    setSaving(true);
    setError(null);
    try {
      await window.agentPlex.saveFile(sessionId, selectedFilePath, content);
      setIsModified(false);
      setEditorContent(content);
      // Refresh parent directory stat silently
      const normalizedPath = selectedFilePath.replace(/\\/g, '/');
      const parentDir = normalizedPath.includes('/')
        ? normalizedPath.substring(0, normalizedPath.lastIndexOf('/'))
        : '';
      fetchDirectory(parentDir, true);
      return true;
    } catch (err: any) {
      setError(err.message || 'Failed to save file');
      return false;
    } finally {
      setSaving(false);
    }
  }, [sessionId, selectedFilePath, saving, fetchDirectory]);

  // Handle file click with unsaved changes check
  const handleSelectFile = useCallback((filePath: string) => {
    if (selectedFilePath === filePath && fileData) return;
    if (isModified) {
      setPendingFilePath(filePath);
      return;
    }
    setSelectedFilePath(filePath);
    loadFile(filePath);
  }, [selectedFilePath, fileData, isModified, loadFile, setSelectedFilePath]);

  // Confirm discarding unsaved changes and opening pending file
  const handleConfirmDiscardAndSwitch = useCallback(() => {
    if (!pendingFilePath) return;
    const target = pendingFilePath;
    setPendingFilePath(null);
    setIsModified(false);
    setSelectedFilePath(target);
    loadFile(target);
  }, [pendingFilePath, loadFile, setSelectedFilePath]);

  // Confirm saving unsaved changes and opening pending file
  const handleConfirmSaveAndSwitch = useCallback(async () => {
    if (!pendingFilePath) return;
    const success = await handleSave();
    if (success) {
      const target = pendingFilePath;
      setPendingFilePath(null);
      setSelectedFilePath(target);
      loadFile(target);
    }
  }, [pendingFilePath, handleSave, loadFile, setSelectedFilePath]);

  // Handle discard modifications
  const handleDiscard = useCallback(() => {
    if (!fileData || !editorRef.current) return;
    editorRef.current.setValue(fileData.content ?? '');
    setIsModified(false);
  }, [fileData]);

  // Handle create file / folder
  const handleStartCreate = (type: 'file' | 'folder', inPath: string = '') => {
    setCreatingType(type);
    setCreatingInPath(inPath);
    setNewItemName('');
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const handleConfirmCreate = async () => {
    const trimmed = newItemName.trim();
    if (!trimmed || !creatingType) {
      setCreatingType(null);
      return;
    }
    const targetPath = creatingInPath ? `${creatingInPath}/${trimmed}` : trimmed;
    try {
      await window.agentPlex.createFile(sessionId, targetPath, creatingType === 'folder');
      await fetchDirectory(creatingInPath, true);
      if (creatingType === 'folder') {
        setExpandedFolders((prev) => new Set(prev).add(targetPath));
      } else {
        handleSelectFile(targetPath);
      }
    } catch (err: any) {
      setError(err.message || `Failed to create ${creatingType}`);
    } finally {
      setCreatingType(null);
      setNewItemName('');
    }
  };

  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  // Editor mounting & shortcuts
  const handleEditorMount = useCallback((editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
    editorInstance.onDidChangeModelContent((e) => {
      if (e.isFlush) return;
      setIsModified(true);
    });
    // Cmd+S / Ctrl+S
    editorInstance.addCommand(
      2097, // KeyMod.CtrlCmd | KeyCode.KeyS
      () => {
        handleSaveRef.current();
      }
    );
  }, []);

  // Global zoom listener
  useEffect(() => {
    return window.agentPlex.onZoom((direction) => {
      if (direction === 'in') setEditorFontSize((s) => Math.min(s + 2, 32));
      else if (direction === 'out') setEditorFontSize((s) => Math.max(s - 2, 8));
      else if (direction === 'reset') setEditorFontSize(13);
    });
  }, []);

  // Window shortcut for Cmd+S / Ctrl+S
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        handleSaveRef.current();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Update editor font size if it changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.updateOptions({ fontSize: editorFontSize });
    }
  }, [editorFontSize]);

  // Recursive tree renderer
  const renderDirectoryItems = (dirPath: string, depth: number) => {
    const items = folderContents[dirPath] || [];

    // Filter by query if present
    const visibleItems = filterQuery.trim()
      ? items.filter((it) => {
          if (it.isDirectory) return true; // keep folders so tree structure is visible
          return it.name.toLowerCase().includes(filterQuery.toLowerCase());
        })
      : items;

    return visibleItems.map((item) => {
      const isExpanded = expandedFolders.has(item.path);
      const isSelected = selectedFilePath === item.path;
      const isLoadingThis = loadingFolders.has(item.path);

      if (item.isDirectory) {
        return (
          <React.Fragment key={item.path}>
            <div
              className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer select-none text-xs rounded transition-colors group ${
                isSelected
                  ? 'bg-accent-subtle text-fg font-medium'
                  : 'text-fg-muted hover:bg-elevated hover:text-fg'
              }`}
              style={{ paddingLeft: `${depth * 14 + 8}px` }}
              onClick={() => toggleFolder(item.path)}
              title={item.path}
            >
              {isExpanded ? (
                <FolderOpen size={14} className="shrink-0 text-accent" />
              ) : (
                <Folder size={14} className="shrink-0 text-fg-muted group-hover:text-fg" />
              )}
              <span className="truncate flex-1 min-w-0 font-medium">{item.name}</span>
              {isLoadingThis && (
                <RefreshCw size={10} className="shrink-0 animate-spin text-fg-muted" />
              )}
            </div>

            {isExpanded && (
              <div>{renderDirectoryItems(item.path, depth + 1)}</div>
            )}
          </React.Fragment>
        );
      }

      // File entry
      return (
        <div
          key={item.path}
          className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer select-none text-xs rounded transition-colors group ${
            isSelected
              ? 'bg-accent-subtle text-fg font-medium'
              : 'text-fg-muted hover:bg-elevated hover:text-fg'
          }`}
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
          onClick={() => handleSelectFile(item.path)}
          title={item.path}
        >
          {getFileIcon(item)}
          <span className="truncate flex-1 min-w-0">{item.name}</span>
          {item.size !== undefined && (
            <span className="text-[10px] text-fg-muted opacity-0 group-hover:opacity-100 shrink-0 font-mono">
              {formatBytes(item.size)}
            </span>
          )}
        </div>
      );
    });
  };

  const monacoThemeName = currentTheme === 'light' ? 'agentplex-light' : 'agentplex-dark';

  return (
    <div className="flex h-full bg-inset overflow-hidden nowheel nopan nodrag nokey">
      {/* Explorer Sidebar */}
      <div className={`${sidebarOpen ? 'w-60' : 'w-0 border-r-0'} shrink-0 border-r border-border flex flex-col bg-surface overflow-hidden transition-[width] duration-150`}>
        {/* Header toolbar */}
        <div className="flex items-center justify-between px-2.5 py-2 border-b border-border">
          <div className="flex items-center gap-1.5 min-w-0">
            <FolderTree size={13} className="shrink-0 text-accent" />
            <span className="text-xs font-semibold text-fg truncate">Files</span>
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              className="p-1 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
              onClick={() => handleStartCreate('file', '')}
              title="New File"
            >
              <FilePlus size={13} />
            </button>
            <button
              className="p-1 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
              onClick={() => handleStartCreate('folder', '')}
              title="New Folder"
            >
              <FolderPlus size={13} />
            </button>
            <button
              className="p-1 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
              onClick={collapseAll}
              title="Collapse All"
            >
              <ChevronsDownUp size={13} />
            </button>
            <button
              className="p-1 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
              onClick={refreshAll}
              title="Refresh"
            >
              <RefreshCw size={13} className={loadingFolders.size > 0 ? 'animate-spin' : ''} />
            </button>
            <button
              className="p-1 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
              onClick={() => setSidebarOpen(false)}
              title="Hide Files Sidebar"
            >
              <PanelLeftClose size={13} />
            </button>
          </div>
        </div>

        {/* Filter input */}
        <div className="p-1.5 border-b border-border">
          <div className="relative flex items-center">
            <Search size={12} className="absolute left-2 text-fg-muted pointer-events-none" />
            <input
              type="text"
              className="w-full pl-6 pr-6 py-1 text-xs bg-inset border border-border rounded text-fg placeholder:text-fg-muted outline-none focus:border-accent"
              placeholder="Filter files..."
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
            />
            {filterQuery && (
              <button
                className="absolute right-1.5 p-0.5 rounded text-fg-muted hover:text-fg"
                onClick={() => setFilterQuery('')}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>

        {/* Inline new file / folder creation */}
        {creatingType && (
          <div className="p-1.5 border-b border-border bg-elevated">
            <div className="flex items-center gap-1">
              {creatingType === 'folder' ? (
                <Folder size={13} className="shrink-0 text-accent" />
              ) : (
                <FileCode size={13} className="shrink-0 text-accent" />
              )}
              <input
                ref={createInputRef}
                type="text"
                className="flex-1 py-0.5 px-1.5 text-xs bg-inset border border-accent rounded text-fg outline-none"
                placeholder={creatingType === 'folder' ? 'Folder name...' : 'File name...'}
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleConfirmCreate();
                  if (e.key === 'Escape') setCreatingType(null);
                }}
              />
              <button
                className="p-1 text-xs text-accent hover:text-accent-hover font-medium"
                onClick={handleConfirmCreate}
              >
                Create
              </button>
              <button
                className="p-1 text-xs text-fg-muted hover:text-fg"
                onClick={() => setCreatingType(null)}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )}

        {/* Tree view */}
        <div className="flex-1 overflow-y-auto no-scrollbar p-1">
          {error && (
            <div className="p-2 mb-1 rounded bg-error/10 text-error text-[11px] flex items-center gap-1.5">
              <AlertCircle size={13} className="shrink-0" />
              <span className="break-words truncate">{error}</span>
            </div>
          )}

          {renderDirectoryItems('', 0)}

          {(!folderContents[''] || folderContents[''].length === 0) && !loadingFolders.has('') && (
            <div className="py-6 px-3 text-center text-xs text-fg-muted">
              No files found
            </div>
          )}
        </div>
      </div>

      {/* Main File Viewer / Editor Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {selectedFilePath && (
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-surface shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              {!sidebarOpen && (
                <button
                  className="p-1 -ml-1 mr-0.5 rounded text-fg-muted hover:bg-elevated hover:text-fg transition-colors shrink-0"
                  onClick={() => setSidebarOpen(true)}
                  title="Show Files Sidebar"
                >
                  <PanelLeftOpen size={13} />
                </button>
              )}
              <span className="text-xs font-medium text-fg truncate" title={selectedFilePath}>
                {selectedFilePath}
              </span>
              {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title="Unsaved changes" />
              )}
              {fileData && (
                <span className="text-[10px] text-fg-muted font-mono shrink-0">
                  {formatBytes(fileData.size)}
                  {fileData.language && ` · ${fileData.language}`}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {isModified && (
                <button
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs text-fg-muted hover:bg-elevated hover:text-fg transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDiscard();
                  }}
                  title="Discard unsaved changes"
                >
                  <RotateCcw size={12} />
                  Revert
                </button>
              )}

              {!fileData?.isBinary && (
                <button
                  className={`flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    isModified
                      ? 'bg-accent text-white hover:bg-accent-hover shadow-sm'
                      : 'bg-elevated text-fg-muted hover:text-fg'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleSave();
                  }}
                  disabled={!isModified || saving}
                  title="Save file (Ctrl+S / Cmd+S)"
                >
                  <Save size={12} />
                  {saving ? 'Saving...' : 'Save'}
                </button>
              )}
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 relative">
          {!sidebarOpen && !selectedFilePath && (
            <div className="absolute top-2 left-2 z-10">
              <button
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface border border-border text-xs text-fg-muted hover:text-fg hover:bg-elevated transition-colors shadow-sm"
                onClick={() => setSidebarOpen(true)}
                title="Show Files Sidebar"
              >
                <PanelLeftOpen size={13} />
                <span>Files</span>
              </button>
            </div>
          )}

          {!selectedFilePath && (
            <div className="flex flex-col items-center justify-center h-full text-fg-muted gap-2 select-none">
              <FolderTree size={36} className="text-border-strong opacity-40 mb-1" />
              <div className="text-xs font-medium text-fg">No file selected</div>
              <div className="text-[11px] text-fg-muted">Choose a file from the explorer to view or edit</div>
            </div>
          )}

          {loadingFile && (
            <div className="flex items-center justify-center h-full text-xs text-fg-muted gap-2">
              <RefreshCw size={14} className="animate-spin text-accent" />
              Loading file...
            </div>
          )}

          {selectedFilePath && !loadingFile && fileData?.isImage && (
            <div className="flex flex-col items-center justify-center h-full p-4 overflow-auto bg-inset">
              <div className="max-w-full max-h-full flex items-center justify-center p-2 rounded border border-border bg-surface/50 shadow-inner">
                <img
                  src={fileData.dataUrl}
                  alt={selectedFilePath}
                  className="max-w-full max-h-[80vh] object-contain rounded"
                />
              </div>
              <div className="mt-2 text-xs text-fg-muted font-mono">
                {selectedFilePath} · {formatBytes(fileData.size)}
              </div>
            </div>
          )}

          {selectedFilePath && !loadingFile && fileData?.isBinary && !fileData.isImage && (
            <div className="flex flex-col items-center justify-center h-full text-fg-muted gap-2 select-none">
              <File size={36} className="text-border-strong opacity-50" />
              <div className="text-xs font-medium text-fg">Binary File</div>
              <div className="text-[11px] text-fg-muted">
                This file cannot be displayed in the text editor ({formatBytes(fileData.size)})
              </div>
            </div>
          )}

          {selectedFilePath && !loadingFile && fileData && !fileData.isBinary && (
            <Editor
              path={selectedFilePath}
              value={editorContent}
              language={fileData.language || 'plaintext'}
              theme={monacoThemeName}
              onMount={handleEditorMount}
              options={{
                readOnly: false,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                fontSize: editorFontSize,
                fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
                lineNumbers: 'on',
                renderWhitespace: 'selection',
                tabSize: 2,
                automaticLayout: true,
                contextmenu: true,
                folding: true,
              }}
            />
          )}
        </div>
      </div>

      {/* Unsaved Changes Confirmation Modal */}
      {pendingFilePath && (
        <div
          className="fixed inset-0 bg-backdrop flex items-center justify-center z-[1000]"
          onClick={() => setPendingFilePath(null)}
        >
          <div
            className="bg-elevated border border-border-strong rounded-xl p-4 w-[360px] shadow-[0_8px_32px_var(--shadow-heavy)]"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="block text-sm font-semibold text-fg mb-1">Unsaved Changes</span>
            <span className="block text-xs text-fg-muted mb-4 leading-relaxed">
              You have unsaved changes in <span className="font-mono text-fg font-medium">{selectedFilePath}</span>. Do you want to save them before switching?
            </span>
            <div className="flex gap-2 justify-end">
              <button
                className="py-1.5 px-3 bg-border text-fg border-none rounded-md text-xs font-medium cursor-pointer transition-colors hover:bg-border-strong"
                onClick={() => setPendingFilePath(null)}
              >
                Cancel
              </button>
              <button
                className="py-1.5 px-3 bg-inset text-fg-muted hover:text-fg border border-border rounded-md text-xs font-medium cursor-pointer transition-colors"
                onClick={handleConfirmDiscardAndSwitch}
              >
                Don't Save
              </button>
              <button
                className="py-1.5 px-3 bg-accent text-white border-none rounded-md text-xs font-semibold cursor-pointer transition-opacity hover:opacity-90 shadow-sm"
                onClick={handleConfirmSaveAndSwitch}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

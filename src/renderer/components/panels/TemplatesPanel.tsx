import { useCallback, useEffect, useState } from 'react';
import { useRef } from 'react';
import { Save, Play, Trash2, FolderOpen, Pencil } from 'lucide-react';
import { useAppStore } from '../../store';
import { SessionStatus, type WorkspaceTemplate, type WorkspaceTemplateSession } from '../../../shared/ipc-channels';

export function TemplatesPanel() {
  const [templates, setTemplates] = useState<WorkspaceTemplate[]>([]);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const editRef = useRef<HTMLInputElement>(null);
  const addSession = useAppStore((s) => s.addSession);
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);

  const liveSessions = Object.values(sessions).filter((s) => s.status !== SessionStatus.Killed);

  useEffect(() => {
    window.agentPlex.templatesLoad().then(setTemplates);
  }, []);

  const handleSave = useCallback(async () => {
    const name = saveName.trim();
    if (!name || liveSessions.length === 0) return;
    setSaving(true);

    // Read persisted state.json to get Claude session UUIDs
    const persisted = await window.agentPlex.getPersistedState();
    // Build a lookup: displayName → claudeSessionUuid
    const uuidByName = new Map<string, string>();
    for (const [, ps] of Object.entries(persisted.sessions)) {
      if (ps.claudeSessionUuid) {
        uuidByName.set(ps.displayName, ps.claudeSessionUuid);
      }
    }

    const templateSessions: WorkspaceTemplateSession[] = liveSessions.map((s) => {
      const name = displayNames[s.id] || s.title;
      return {
        name,
        cwd: s.cwd,
        cli: s.cli,
        sessionId: uuidByName.get(name) || undefined,
      };
    });

    const template: WorkspaceTemplate = {
      id: `tpl_${Date.now()}`,
      name,
      sessions: templateSessions,
      createdAt: new Date().toISOString(),
    };

    const updated = [...templates, template];
    await window.agentPlex.templatesSave(updated);
    setTemplates(updated);
    setSaveName('');
    setSaving(false);
  }, [saveName, liveSessions, displayNames, templates]);

  const handleLaunch = useCallback(async (template: WorkspaceTemplate) => {
    setLaunching(template.id);

    // Build set of already-active session UUIDs and display names to skip duplicates
    const currentSessions = useAppStore.getState().sessions;
    const currentNames = useAppStore.getState().displayNames;
    const activeNames = new Set<string>();
    const activeUuids = new Set<string>();
    for (const s of Object.values(currentSessions)) {
      if (s.status === SessionStatus.Killed) continue;
      activeNames.add(currentNames[s.id] || s.title);
      if (s.claudeSessionUuid) activeUuids.add(s.claudeSessionUuid);
    }

    let skipped = 0;
    for (const s of template.sessions) {
      // Skip if this session is already active (match by UUID or display name)
      if (s.sessionId && activeUuids.has(s.sessionId)) { skipped++; continue; }
      if (activeNames.has(s.name)) { skipped++; continue; }

      try {
        const info = await window.agentPlex.createSession(s.cwd, s.cli, s.sessionId);
        addSession(info);
        useAppStore.getState().renameSession(info.id, s.name);
      } catch (err) {
        console.error(`[template] Failed to launch session "${s.name}":`, err);
      }
    }
    if (skipped > 0) {
      console.log(`[template] Skipped ${skipped} already-active session(s)`);
    }
    setLaunching(null);
  }, [addSession]);

  const handleDelete = useCallback(async (templateId: string) => {
    const updated = templates.filter((t) => t.id !== templateId);
    await window.agentPlex.templatesSave(updated);
    setTemplates(updated);
  }, [templates]);

  const handleStartRename = useCallback((t: WorkspaceTemplate) => {
    setEditingId(t.id);
    setEditName(t.name);
    setTimeout(() => editRef.current?.select(), 0);
  }, []);

  const handleCommitRename = useCallback(async () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (trimmed) {
      const updated = templates.map((t) =>
        t.id === editingId ? { ...t, name: trimmed } : t
      );
      await window.agentPlex.templatesSave(updated);
      setTemplates(updated);
    }
    setEditingId(null);
  }, [editingId, editName, templates]);

  return (
    <div className="flex flex-col h-full">
      {/* Save current workspace */}
      <div className="p-3 border-b border-border">
        <div className="flex gap-1.5">
          <input
            className="flex-1 min-w-0 px-2 py-1.5 bg-elevated border border-border rounded-md text-xs text-fg placeholder-fg-muted outline-none focus:border-accent"
            placeholder="Template name..."
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') handleSave(); }}
            onMouseDown={(e) => e.stopPropagation()}
          />
          <button
            onClick={handleSave}
            disabled={!saveName.trim() || liveSessions.length === 0 || saving}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors bg-accent-subtle text-accent hover:bg-accent-subtle-hover disabled:opacity-40 disabled:pointer-events-none"
            title={liveSessions.length === 0 ? 'No active sessions to save' : 'Save current sessions as template'}
          >
            <Save size={12} />
            Save
          </button>
        </div>
        {liveSessions.length > 0 && (
          <div className="mt-1.5 text-[10px] text-fg-muted">
            {liveSessions.length} active session{liveSessions.length !== 1 ? 's' : ''} will be saved
          </div>
        )}
      </div>

      {/* Template list */}
      <div className="flex-1 overflow-y-auto">
        {templates.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-fg-muted text-xs gap-1.5">
            <LayoutTemplateIcon />
            <span>No templates yet</span>
            <span className="text-[10px]">Save your workspace above</span>
          </div>
        )}
        {templates.map((t) => (
          <div
            key={t.id}
            className="group flex items-center gap-2.5 px-3 py-2.5 border-b border-border hover:bg-elevated transition-colors"
          >
            <div className="flex-1 min-w-0">
              {editingId === t.id ? (
                <input
                  ref={editRef}
                  className="w-full px-1 py-0.5 bg-elevated border border-accent rounded text-xs text-fg outline-none"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={handleCommitRename}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') handleCommitRename();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="text-xs font-medium text-fg truncate">{t.name}</div>
              )}
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="text-[10px] text-fg-muted">
                  {t.sessions.length} session{t.sessions.length !== 1 ? 's' : ''}
                </span>
                <span className="text-[10px] text-fg-muted">
                  {new Date(t.createdAt).toLocaleDateString()}
                </span>
              </div>
              <div className="flex flex-wrap gap-1 mt-1">
                {t.sessions.map((s, i) => (
                  <span key={i} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface text-[9px] text-fg-muted">
                    <FolderOpen size={8} />
                    {s.name}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => handleLaunch(t)}
                disabled={launching === t.id}
                className="flex items-center justify-center w-6 h-6 rounded text-accent hover:bg-accent-subtle transition-colors"
                title="Launch template"
              >
                <Play size={12} />
              </button>
              <button
                onClick={() => handleStartRename(t)}
                className="flex items-center justify-center w-6 h-6 rounded text-fg-muted hover:text-fg hover:bg-elevated transition-colors"
                title="Rename template"
              >
                <Pencil size={12} />
              </button>
              <button
                onClick={() => handleDelete(t.id)}
                className="flex items-center justify-center w-6 h-6 rounded text-fg-muted hover:text-error hover:bg-error-subtle transition-colors"
                title="Delete template"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LayoutTemplateIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-muted">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" />
      <path d="M9 21V9" />
    </svg>
  );
}

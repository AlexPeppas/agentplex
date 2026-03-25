# Side Panel & Activity Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style activity bar and collapsible side panel to AgentPlex with Explorer, Session Explorer, Search, and placeholder panels.

**Architecture:** Monolithic component approach — a single `SidePanel` component conditionally renders panel content based on `activePanelId` from the Zustand store. An `ActivityBar` component provides the icon strip with VS Code toggle behavior. The layout inserts these to the left of the existing graph canvas.

**Tech Stack:** React 18, Zustand, TypeScript, CSS custom properties, Electron IPC (for file search)

---

### Task 1: Expose `cwd` in SessionInfo

Add `cwd` to the shared `SessionInfo` interface so the renderer knows which working directory each session belongs to.

**Files:**
- Modify: `src/shared/ipc-channels.ts:25-30`
- Modify: `src/main/session-manager.ts:282` (createWithUuid return)
- Modify: `src/main/session-manager.ts:440` (create return)
- Modify: `src/main/session-manager.ts:486-491` (list method)

- [ ] **Step 1: Add `cwd` to `SessionInfo` interface**

In `src/shared/ipc-channels.ts`, add `cwd` to the `SessionInfo` interface:

```typescript
export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
  cwd: string;
}
```

- [ ] **Step 2: Include `cwd` in `create()` return value**

In `src/main/session-manager.ts`, update the return at the end of `create()` (around line 440):

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir };
```

- [ ] **Step 3: Include `cwd` in `createWithUuid()` return value**

In `src/main/session-manager.ts`, update the return at the end of `createWithUuid()` (around line 282):

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir };
```

- [ ] **Step 4: Include `cwd` in `list()` return value**

In `src/main/session-manager.ts`, update the `list()` method (around line 486):

```typescript
list(): SessionInfo[] {
  return Array.from(this.sessions.values()).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    pid: s.pty.pid,
    cwd: s.cwd,
  }));
}
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to SessionInfo

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/session-manager.ts
git commit -m "feat: expose cwd in SessionInfo for side panel"
```

---

### Task 2: Add Side Panel State to Zustand Store

Add `activePanelId`, `sidePanelWidth`, and their actions to the store.

**Files:**
- Modify: `src/renderer/store.ts`

- [ ] **Step 1: Add type for panel IDs**

At the top of `src/renderer/store.ts`, add:

```typescript
export type PanelId = 'explorer' | 'sessions' | 'search' | 'git' | 'extensions';
```

- [ ] **Step 2: Add state fields to AppState interface**

In the `AppState` interface, add after the `sendDialogSourceId` line:

```typescript
// Side panel
activePanelId: PanelId | null;
sidePanelWidth: number;
togglePanel: (panelId: PanelId) => void;
setSidePanelWidth: (width: number) => void;
```

- [ ] **Step 3: Add initial state and actions to the store**

In the `create<AppState>` call, add initial values after `sendDialogSourceId: null,`:

```typescript
activePanelId: null,
sidePanelWidth: 240,
```

Add actions after `closeSendDialog`:

```typescript
togglePanel: (panelId: PanelId) => {
  const current = get().activePanelId;
  set({ activePanelId: current === panelId ? null : panelId });
},

setSidePanelWidth: (width: number) => {
  set({ sidePanelWidth: Math.max(160, Math.min(400, width)) });
},
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store.ts
git commit -m "feat: add side panel state to Zustand store"
```

---

### Task 3: Create ActivityBar Component

The narrow icon strip on the far left with VS Code toggle behavior.

**Files:**
- Create: `src/renderer/components/ActivityBar.tsx`

- [ ] **Step 1: Create the ActivityBar component**

Create `src/renderer/components/ActivityBar.tsx`:

```tsx
import { useAppStore, type PanelId } from '../store';

interface PanelDef {
  id: PanelId;
  label: string;
  icon: string;
  enabled: boolean;
}

const PANELS: PanelDef[] = [
  { id: 'explorer', label: 'Explorer', icon: '\u{1F4C1}', enabled: true },
  { id: 'sessions', label: 'Sessions', icon: '\u{1F5A5}', enabled: true },
  { id: 'search', label: 'Search', icon: '\u{1F50D}', enabled: true },
  { id: 'git', label: 'Git', icon: '\u2442', enabled: false },
  { id: 'extensions', label: 'Extensions', icon: '\u26A1', enabled: false },
];

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);

  return (
    <div className="activity-bar">
      {PANELS.map((panel) => (
        <button
          key={panel.id}
          className={`activity-bar__icon ${activePanelId === panel.id ? 'activity-bar__icon--active' : ''} ${!panel.enabled ? 'activity-bar__icon--disabled' : ''}`}
          title={panel.enabled ? panel.label : `${panel.label} (Coming soon)`}
          onClick={() => panel.enabled && togglePanel(panel.id)}
        >
          {panel.icon}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ActivityBar.tsx
git commit -m "feat: create ActivityBar component"
```

---

### Task 4: Create SidePanel Container and PlaceholderPanel

The container that switches between panel views, plus the "Coming soon" placeholder.

**Files:**
- Create: `src/renderer/components/SidePanel.tsx`
- Create: `src/renderer/components/panels/PlaceholderPanel.tsx`

- [ ] **Step 1: Create the PlaceholderPanel component**

Create `src/renderer/components/panels/PlaceholderPanel.tsx`:

```tsx
interface PlaceholderPanelProps {
  icon: string;
  label: string;
}

export function PlaceholderPanel({ icon, label }: PlaceholderPanelProps) {
  return (
    <div className="placeholder-panel">
      <span className="placeholder-panel__icon">{icon}</span>
      <span className="placeholder-panel__label">{label}</span>
      <span className="placeholder-panel__text">Coming soon</span>
    </div>
  );
}
```

- [ ] **Step 2: Create the SidePanel container**

Create `src/renderer/components/SidePanel.tsx`:

```tsx
import { useAppStore } from '../store';
import { PlaceholderPanel } from './panels/PlaceholderPanel';

export function SidePanel() {
  const activePanelId = useAppStore((s) => s.activePanelId);

  const panelTitle: Record<string, string> = {
    explorer: 'Explorer',
    sessions: 'Sessions',
    search: 'Search',
    git: 'Git',
    extensions: 'Extensions',
  };

  return (
    <div className="side-panel">
      <div className="side-panel__header">
        {panelTitle[activePanelId || ''] || ''}
      </div>
      <div className="side-panel__content">
        {activePanelId === 'explorer' && (
          <div className="placeholder-panel">
            <span className="placeholder-panel__text">Explorer — wired in Task 6</span>
          </div>
        )}
        {activePanelId === 'sessions' && (
          <div className="placeholder-panel">
            <span className="placeholder-panel__text">Sessions — wired in Task 7</span>
          </div>
        )}
        {activePanelId === 'search' && (
          <div className="placeholder-panel">
            <span className="placeholder-panel__text">Search — wired in Task 9</span>
          </div>
        )}
        {activePanelId === 'git' && (
          <PlaceholderPanel icon={'\u2442'} label="Git" />
        )}
        {activePanelId === 'extensions' && (
          <PlaceholderPanel icon={'\u26A1'} label="Extensions" />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SidePanel.tsx src/renderer/components/panels/PlaceholderPanel.tsx
git commit -m "feat: create SidePanel container and PlaceholderPanel"
```

---

### Task 5: Integrate into App Layout + Add CSS

Wire ActivityBar and SidePanel into `App.tsx` and add all CSS styles.

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `styles/index.css`

- [ ] **Step 1: Add imports and side panel resize handler to App.tsx**

In `src/renderer/App.tsx`, add imports:

```tsx
import { ActivityBar } from './components/ActivityBar';
import { SidePanel } from './components/SidePanel';
```

Add store selectors inside the `App` function (after existing selectors):

```tsx
const activePanelId = useAppStore((s) => s.activePanelId);
const sidePanelWidth = useAppStore((s) => s.sidePanelWidth);
const setSidePanelWidth = useAppStore((s) => s.setSidePanelWidth);
```

Add a side panel resize handler (after the existing `handleResizeStart`):

```tsx
const handleSidePanelResizeStart = useCallback((e: React.MouseEvent) => {
  e.preventDefault();
  dragging.current = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (ev: MouseEvent) => {
    if (!dragging.current || !contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    // 48px for activity bar width
    const px = ev.clientX - rect.left - 48;
    setSidePanelWidth(px);
  };

  const onUp = () => {
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}, [setSidePanelWidth]);
```

- [ ] **Step 2: Update the JSX layout in App.tsx**

Replace the return JSX with:

```tsx
return (
  <div className="app">
    <Toolbar />
    <div className="app__content" ref={contentRef}>
      <ActivityBar />
      {activePanelId && (
        <>
          <div className="app__side-panel" style={{ width: sidePanelWidth }}>
            <SidePanel />
          </div>
          <div className="app__resize-handle" onMouseDown={handleSidePanelResizeStart} />
        </>
      )}
      <div
        className="app__graph"
        style={selectedSessionId ? { flex: `0 0 ${100 - terminalWidth}%` } : undefined}
      >
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </div>
      {selectedSessionId && (
        <>
          <div className="app__resize-handle" onMouseDown={handleResizeStart} />
          <div className="app__terminal" style={{ flex: `0 0 ${terminalWidth}%` }}>
            <TerminalPanel />
          </div>
        </>
      )}
    </div>
    {sendDialogSourceId && <SendDialog />}
  </div>
);
```

- [ ] **Step 3: Add CSS for activity bar, side panel, and panels**

Append the following to `styles/index.css`:

```css
/* ═══════════════════════════════════════════════════════════
   Activity Bar
   ═══════════════════════════════════════════════════════════ */
.activity-bar {
  flex: 0 0 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  gap: 4px;
  background: var(--bg-inset);
  border-right: 1px solid var(--border);
}

.activity-bar__icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  font-size: 18px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  position: relative;
}

.activity-bar__icon:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.activity-bar__icon--active {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.activity-bar__icon--active::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--accent);
  border-radius: 1px;
}

.activity-bar__icon--disabled {
  opacity: 0.4;
  cursor: default;
}

.activity-bar__icon--disabled:hover {
  background: transparent;
  color: var(--text-muted);
}

/* ═══════════════════════════════════════════════════════════
   Side Panel
   ═══════════════════════════════════════════════════════════ */
.app__side-panel {
  flex-shrink: 0;
  overflow: hidden;
}

.side-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-primary);
  border-right: 1px solid var(--border);
}

.side-panel__header {
  padding: 10px 14px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.side-panel__content {
  flex: 1;
  overflow-y: auto;
}

/* ─── Tree items ─── */
.tree-item {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 14px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: background 0.12s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item:hover {
  background: var(--bg-elevated);
}

.tree-item--selected {
  background: var(--accent-subtle);
  border-left: 2px solid var(--accent);
  padding-left: 12px;
}

.tree-item--directory {
  color: var(--text-muted);
  font-size: 12px;
  text-transform: none;
}

.tree-item--session {
  padding-left: 28px;
}

.tree-item--session.tree-item--selected {
  padding-left: 26px;
}

.tree-item__arrow {
  font-size: 10px;
  width: 12px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.tree-item__status {
  flex-shrink: 0;
}

.tree-item__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-item__secondary {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

/* ─── Placeholder panel ─── */
.placeholder-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 8px;
  color: var(--text-muted);
}

.placeholder-panel__icon {
  font-size: 32px;
  opacity: 0.4;
}

.placeholder-panel__label {
  font-size: 14px;
  font-weight: 500;
}

.placeholder-panel__text {
  font-size: 12px;
  opacity: 0.6;
}

/* ─── Search panel ─── */
.search-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.search-panel__tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.search-panel__tab {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  border-bottom: 2px solid transparent;
}

.search-panel__tab:hover {
  color: var(--text-primary);
}

.search-panel__tab--active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
}

.search-panel__input-wrapper {
  padding: 8px;
  flex-shrink: 0;
}

.search-panel__input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-inset);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s;
}

.search-panel__input:focus {
  border-color: var(--accent);
}

.search-panel__results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.search-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 14px;
  cursor: pointer;
  transition: background 0.12s;
  font-size: 12px;
}

.search-result:hover {
  background: var(--bg-elevated);
}

.search-result__source {
  color: var(--text-muted);
  font-size: 11px;
}

.search-result__match {
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.search-result__match mark {
  background: var(--accent-subtle-strong);
  color: var(--accent);
  border-radius: 2px;
  padding: 0 2px;
}

/* ─── Empty state ─── */
.panel-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: 13px;
  padding: 14px;
  text-align: center;
}
```

- [ ] **Step 4: Verify the app builds**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx styles/index.css
git commit -m "feat: integrate activity bar and side panel into layout"
```

---

### Task 6: Create ExplorerPanel

The workspace-first tree that groups sessions under their working directories.

**Files:**
- Create: `src/renderer/components/panels/ExplorerPanel.tsx`
- Modify: `src/renderer/components/SidePanel.tsx`

- [ ] **Step 1: Create the ExplorerPanel component**

Create `src/renderer/components/panels/ExplorerPanel.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { useAppStore } from '../../store';
import { StatusIndicator } from '../StatusIndicator';
import type { SessionInfo } from '../../../shared/ipc-channels';

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const displayNames = useAppStore((s) => s.displayNames);

  const tree = useMemo(() => {
    const groups: Record<string, SessionInfo[]> = {};
    for (const session of Object.values(sessions)) {
      const cwd = session.cwd || 'Unknown';
      (groups[cwd] ??= []).push(session);
    }
    return groups;
  }, [sessions]);

  const cwds = Object.keys(tree);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(cwds.map((cwd) => [cwd, true]))
  );

  // Expand newly-appeared directories
  useMemo(() => {
    for (const cwd of cwds) {
      if (!(cwd in expanded)) {
        setExpanded((prev) => ({ ...prev, [cwd]: true }));
      }
    }
  }, [cwds.join(',')]);

  const toggleDir = (cwd: string) => {
    setExpanded((prev) => ({ ...prev, [cwd]: !prev[cwd] }));
  };

  const dirName = (cwd: string) => cwd.replace(/\\/g, '/').split('/').pop() || cwd;

  if (cwds.length === 0) {
    return <div className="panel-empty">No sessions yet</div>;
  }

  return (
    <div>
      {cwds.map((cwd) => (
        <div key={cwd}>
          <div
            className="tree-item tree-item--directory"
            title={cwd}
            onClick={() => toggleDir(cwd)}
          >
            <span className="tree-item__arrow">{expanded[cwd] ? '\u25BE' : '\u25B8'}</span>
            <span className="tree-item__label">{dirName(cwd)}</span>
          </div>
          {expanded[cwd] &&
            tree[cwd].map((session) => (
              <div
                key={session.id}
                className={`tree-item tree-item--session ${selectedSessionId === session.id ? 'tree-item--selected' : ''}`}
                onClick={() => selectSession(session.id)}
              >
                <span className="tree-item__status">
                  <StatusIndicator status={session.status} />
                </span>
                <span className="tree-item__label">
                  {displayNames[session.id] || session.title}
                </span>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire ExplorerPanel into SidePanel**

In `src/renderer/components/SidePanel.tsx`, add the import:

```tsx
import { ExplorerPanel } from './panels/ExplorerPanel';
```

Replace the explorer placeholder block:

```tsx
{activePanelId === 'explorer' && <ExplorerPanel />}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/panels/ExplorerPanel.tsx src/renderer/components/SidePanel.tsx
git commit -m "feat: create ExplorerPanel with workspace-first tree"
```

---

### Task 7: Create SessionExplorerPanel

Flat list of all sessions sorted by status.

**Files:**
- Create: `src/renderer/components/panels/SessionExplorerPanel.tsx`
- Modify: `src/renderer/components/SidePanel.tsx`

- [ ] **Step 1: Create the SessionExplorerPanel component**

Create `src/renderer/components/panels/SessionExplorerPanel.tsx`:

```tsx
import { useMemo } from 'react';
import { useAppStore } from '../../store';
import { SessionStatus } from '../../../shared/ipc-channels';
import { StatusIndicator } from '../StatusIndicator';

const STATUS_ORDER: Record<SessionStatus, number> = {
  [SessionStatus.WaitingForInput]: 0,
  [SessionStatus.Running]: 1,
  [SessionStatus.Idle]: 2,
  [SessionStatus.Killed]: 3,
};

const STATUS_LABEL: Record<SessionStatus, string> = {
  [SessionStatus.Running]: 'running',
  [SessionStatus.Idle]: 'idle',
  [SessionStatus.WaitingForInput]: 'waiting',
  [SessionStatus.Killed]: 'killed',
};

export function SessionExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const displayNames = useAppStore((s) => s.displayNames);

  const sorted = useMemo(() => {
    return Object.values(sessions).sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
    );
  }, [sessions]);

  const dirName = (cwd: string) => cwd.replace(/\\/g, '/').split('/').pop() || cwd;

  if (sorted.length === 0) {
    return <div className="panel-empty">No sessions yet</div>;
  }

  return (
    <div>
      {sorted.map((session) => (
        <div
          key={session.id}
          className={`tree-item ${selectedSessionId === session.id ? 'tree-item--selected' : ''}`}
          onClick={() => selectSession(session.id)}
        >
          <span className="tree-item__status">
            <StatusIndicator status={session.status} />
          </span>
          <span className="tree-item__label">
            {displayNames[session.id] || session.title}
          </span>
          <span className="tree-item__secondary">
            {STATUS_LABEL[session.status]} · {dirName(session.cwd || '')}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Wire SessionExplorerPanel into SidePanel**

In `src/renderer/components/SidePanel.tsx`, add the import:

```tsx
import { SessionExplorerPanel } from './panels/SessionExplorerPanel';
```

Replace the sessions placeholder block:

```tsx
{activePanelId === 'sessions' && <SessionExplorerPanel />}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/panels/SessionExplorerPanel.tsx src/renderer/components/SidePanel.tsx
git commit -m "feat: create SessionExplorerPanel with sorted session list"
```

---

### Task 8: Add File Search IPC

Add the `search:files` IPC channel for searching file contents from the main process.

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/preload/preload.ts`
- Modify: `src/renderer/types.ts`

- [ ] **Step 1: Add IPC channel constant**

In `src/shared/ipc-channels.ts`, add to the `IPC` object:

```typescript
SEARCH_FILES: 'search:files',
```

Add the result type after `TaskListInfo`:

```typescript
export interface FileSearchResult {
  file: string;
  line: number;
  text: string;
}
```

- [ ] **Step 2: Add the handler in ipc-handlers.ts**

In `src/main/ipc-handlers.ts`, add at the top:

```typescript
import * as fs from 'fs';
import * as path from 'path';
```

Add the handler inside `registerIpcHandlers()`:

```typescript
ipcMain.handle(IPC.SEARCH_FILES, async (_event, { query, cwd }: { query: string; cwd: string }) => {
  if (!query || !cwd) return [];
  const results: { file: string; line: number; text: string }[] = [];
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.vite', '.next', '__pycache__']);
  const MAX_RESULTS = 100;
  const MAX_FILE_SIZE = 1024 * 1024; // 1MB

  function walk(dir: string) {
    if (results.length >= MAX_RESULTS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (IGNORE.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          if (stat.size > MAX_FILE_SIZE) continue;
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (results.length >= MAX_RESULTS) break;
            if (lines[i].toLowerCase().includes(query.toLowerCase())) {
              results.push({
                file: path.relative(cwd, full).replace(/\\/g, '/'),
                line: i + 1,
                text: lines[i].trim().slice(0, 200),
              });
            }
          }
        } catch {
          // skip binary or unreadable files
        }
      }
    }
  }

  walk(cwd);
  return results;
});
```

- [ ] **Step 3: Expose in preload**

In `src/preload/preload.ts`, add to the `api` object:

```typescript
searchFiles: (query: string, cwd: string): Promise<{ file: string; line: number; text: string }[]> => {
  return ipcRenderer.invoke(IPC.SEARCH_FILES, { query, cwd });
},
```

- [ ] **Step 4: Add to AgentPlexAPI type**

In `src/renderer/types.ts`, add to the `AgentPlexAPI` interface:

```typescript
searchFiles: (query: string, cwd: string) => Promise<{ file: string; line: number; text: string }[]>;
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc-handlers.ts src/preload/preload.ts src/renderer/types.ts
git commit -m "feat: add search:files IPC channel for file content search"
```

---

### Task 9: Create SearchPanel

Two-mode search panel with session output and file content search.

**Files:**
- Create: `src/renderer/components/panels/SearchPanel.tsx`
- Modify: `src/renderer/components/SidePanel.tsx`

- [ ] **Step 1: Create the SearchPanel component**

Create `src/renderer/components/panels/SearchPanel.tsx`:

```tsx
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
```

- [ ] **Step 2: Wire SearchPanel into SidePanel**

In `src/renderer/components/SidePanel.tsx`, add the import:

```tsx
import { SearchPanel } from './panels/SearchPanel';
```

Replace the search placeholder block:

```tsx
{activePanelId === 'search' && <SearchPanel />}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/panels/SearchPanel.tsx src/renderer/components/SidePanel.tsx
git commit -m "feat: create SearchPanel with session and file search"
```

---

### Task 10: Manual Smoke Test

Verify everything works end-to-end.

- [ ] **Step 1: Build and run the app**

Run: `npm start`
Expected: App launches without errors

- [ ] **Step 2: Verify activity bar renders**

Expected: 5 icons on the far left, Git and Extensions dimmed

- [ ] **Step 3: Test toggle behavior**

Click Explorer icon — side panel opens with "EXPLORER" header.
Click Explorer icon again — side panel collapses.
Click Sessions icon — side panel opens with sessions view.

- [ ] **Step 4: Test Explorer panel**

Create a new session. Verify it appears under the correct working directory in the explorer tree. Click the session — terminal opens on the right.

- [ ] **Step 5: Test resize**

Drag the resize handle between side panel and graph. Verify it respects 160px min / 400px max.

- [ ] **Step 6: Test search**

Open Search panel. Type a query in Sessions mode. Verify results appear. Switch to Files mode and search.

- [ ] **Step 7: Verify theme toggle**

Switch between dark and light themes. Verify activity bar and side panel colors update correctly.

- [ ] **Step 8: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address smoke test issues"
```

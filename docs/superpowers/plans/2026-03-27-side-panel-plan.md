# Side Panel & Activity Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style activity bar and collapsible side panel with Explorer and Search panels, rebuilt with pure Tailwind CSS.

**Architecture:** ActivityBar (always visible, 48px) toggles a SidePanel container that routes to Explorer, Search, or Placeholder panels. Explorer groups sessions by cwd in a tree. Search filters session buffers client-side. All state lives in Zustand.

**Tech Stack:** React 19, Zustand 5, Tailwind CSS 4, Lucide React icons, xterm.js (existing)

---

### Task 1: Add `cwd` to `SessionInfo` shared type

The Explorer panel needs to group sessions by working directory. `SessionInfo` currently lacks `cwd`.

**Files:**
- Modify: `src/shared/ipc-channels.ts:27-32`
- Modify: `src/main/session-manager.ts:308,479,524-531`

- [ ] **Step 1: Add `cwd` to `SessionInfo` interface**

In `src/shared/ipc-channels.ts`, add `cwd` to the interface:

```typescript
export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
  cwd: string;
}
```

- [ ] **Step 2: Update `createWithUuid` return value**

In `src/main/session-manager.ts` line 308, change:

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid };
```

to:

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir };
```

- [ ] **Step 3: Update `create` return value**

In `src/main/session-manager.ts` line 479, change:

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid };
```

to:

```typescript
return { id, title, status: SessionStatus.Running, pid: term.pid, cwd: workDir };
```

- [ ] **Step 4: Update `list()` return value**

In `src/main/session-manager.ts` lines 524-531, change:

```typescript
list(): SessionInfo[] {
  return Array.from(this.sessions.values()).map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    pid: s.pty.pid,
  }));
}
```

to:

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
Expected: No new errors related to SessionInfo

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/session-manager.ts
git commit -m "feat: add cwd to SessionInfo shared type"
```

---

### Task 2: Add side panel state to Zustand store

**Files:**
- Modify: `src/renderer/store.ts`

- [ ] **Step 1: Add PanelId type and new state fields to AppState interface**

After the existing `launcherCli` field in the `AppState` interface (around line 109), add:

```typescript
// Side panel
activePanelId: PanelId | null;
sidePanelWidth: number;
togglePanel: (panelId: PanelId) => void;
setSidePanelWidth: (width: number) => void;
```

And add the type export before the `AppState` interface (around line 58):

```typescript
export type PanelId = 'explorer' | 'search' | 'git' | 'extensions';
```

- [ ] **Step 2: Add default values and action implementations**

After the `closeLauncher` implementation (around line 138), add:

```typescript
activePanelId: null,
sidePanelWidth: 240,

togglePanel: (panelId: PanelId) => {
  set((state) => ({
    activePanelId: state.activePanelId === panelId ? null : panelId,
  }));
},

setSidePanelWidth: (width: number) => {
  set({ sidePanelWidth: Math.max(160, Math.min(400, width)) });
},
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store.ts
git commit -m "feat: add side panel state to Zustand store"
```

---

### Task 3: Create ActivityBar component

**Files:**
- Create: `src/renderer/components/ActivityBar.tsx`

- [ ] **Step 1: Create the ActivityBar component**

Create `src/renderer/components/ActivityBar.tsx`:

```tsx
import { FolderOpen, Search, GitBranch, Puzzle } from 'lucide-react';
import { useAppStore, type PanelId } from '../store';

const PANELS: { id: PanelId; icon: typeof FolderOpen; disabled?: boolean }[] = [
  { id: 'explorer', icon: FolderOpen },
  { id: 'search', icon: Search },
  { id: 'git', icon: GitBranch, disabled: true },
  { id: 'extensions', icon: Puzzle, disabled: true },
];

export function ActivityBar() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const togglePanel = useAppStore((s) => s.togglePanel);

  return (
    <div className="flex-none w-12 flex flex-col items-center pt-2 gap-1 bg-inset border-r border-border">
      {PANELS.map(({ id, icon: Icon, disabled }) => {
        const isActive = activePanelId === id;
        return (
          <button
            key={id}
            onClick={() => !disabled && togglePanel(id)}
            className={`relative w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-[120ms]
              ${disabled ? 'opacity-40 cursor-default' : 'cursor-pointer'}
              ${isActive ? 'bg-elevated text-fg' : 'text-fg-muted hover:bg-elevated hover:text-fg'}
              ${disabled ? '' : 'hover:text-fg'}`}
            title={id.charAt(0).toUpperCase() + id.slice(1)}
          >
            {isActive && (
              <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-accent rounded-r-sm" />
            )}
            <Icon size={20} />
          </button>
        );
      })}
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

### Task 4: Create PlaceholderPanel component

**Files:**
- Create: `src/renderer/components/panels/PlaceholderPanel.tsx`

- [ ] **Step 1: Create the PlaceholderPanel component**

Create `src/renderer/components/panels/PlaceholderPanel.tsx`:

```tsx
import { GitBranch, Puzzle } from 'lucide-react';
import type { PanelId } from '../../store';

const PANEL_META: Record<string, { icon: typeof GitBranch; label: string }> = {
  git: { icon: GitBranch, label: 'Source Control' },
  extensions: { icon: Puzzle, label: 'Extensions' },
};

export function PlaceholderPanel({ panelId }: { panelId: PanelId }) {
  const meta = PANEL_META[panelId] || { icon: Puzzle, label: panelId };
  const Icon = meta.icon;

  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 text-fg-muted">
      <Icon size={32} className="opacity-40" />
      <span className="text-sm font-medium">{meta.label}</span>
      <span className="text-xs">Coming soon</span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/panels/PlaceholderPanel.tsx
git commit -m "feat: create PlaceholderPanel component"
```

---

### Task 5: Create ExplorerPanel component

**Files:**
- Create: `src/renderer/components/panels/ExplorerPanel.tsx`

- [ ] **Step 1: Create the ExplorerPanel component**

Create `src/renderer/components/panels/ExplorerPanel.tsx`:

```tsx
import { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { useAppStore } from '../../store';
import { StatusIndicator } from '../StatusIndicator';

interface DirEntry {
  cwd: string;
  dirName: string;
  sessions: { id: string; label: string; status: import('../../../shared/ipc-channels').SessionStatus }[];
}

export function ExplorerPanel() {
  const sessions = useAppStore((s) => s.sessions);
  const displayNames = useAppStore((s) => s.displayNames);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const selectSession = useAppStore((s) => s.selectSession);

  const tree = useMemo(() => {
    const dirs = new Map<string, DirEntry>();
    for (const s of Object.values(sessions)) {
      const cwd = s.cwd || 'Unknown';
      if (!dirs.has(cwd)) {
        const dirName = cwd.replace(/\\/g, '/').split('/').pop() || cwd;
        dirs.set(cwd, { cwd, dirName, sessions: [] });
      }
      dirs.get(cwd)!.sessions.push({
        id: s.id,
        label: displayNames[s.id] || s.title,
        status: s.status,
      });
    }
    return Array.from(dirs.values());
  }, [sessions, displayNames]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (cwd: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  };

  if (tree.length === 0) {
    return (
      <div className="p-4 text-center text-fg-muted text-xs">
        No sessions yet
      </div>
    );
  }

  return (
    <div className="py-1">
      {tree.map((dir) => (
        <div key={dir.cwd}>
          <button
            onClick={() => toggle(dir.cwd)}
            className="flex items-center gap-2 w-full h-7 px-3.5 text-xs text-fg-muted hover:bg-elevated transition-colors cursor-pointer"
            title={dir.cwd}
          >
            {collapsed.has(dir.cwd) ? (
              <ChevronRight size={12} className="shrink-0" />
            ) : (
              <ChevronDown size={12} className="shrink-0" />
            )}
            <span className="truncate">{dir.dirName}</span>
          </button>
          {!collapsed.has(dir.cwd) &&
            dir.sessions.map((s) => {
              const isSelected = selectedSessionId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => selectSession(s.id)}
                  className={`flex items-center gap-2 w-full h-7 pl-7 pr-3.5 text-xs transition-colors cursor-pointer
                    ${isSelected
                      ? 'bg-accent-subtle border-l-2 border-accent pl-[26px]'
                      : 'hover:bg-elevated'}`}
                >
                  <StatusIndicator status={s.status} />
                  <span className="truncate text-fg">{s.label}</span>
                </button>
              );
            })}
        </div>
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
git add src/renderer/components/panels/ExplorerPanel.tsx
git commit -m "feat: create ExplorerPanel component"
```

---

### Task 6: Create SearchPanel component

**Files:**
- Create: `src/renderer/components/panels/SearchPanel.tsx`

- [ ] **Step 1: Create the SearchPanel component**

Create `src/renderer/components/panels/SearchPanel.tsx`:

```tsx
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/panels/SearchPanel.tsx
git commit -m "feat: create SearchPanel component"
```

---

### Task 7: Create SidePanel container component

**Files:**
- Create: `src/renderer/components/SidePanel.tsx`

- [ ] **Step 1: Create the SidePanel component**

Create `src/renderer/components/SidePanel.tsx`:

```tsx
import { useAppStore } from '../store';
import { ExplorerPanel } from './panels/ExplorerPanel';
import { SearchPanel } from './panels/SearchPanel';
import { PlaceholderPanel } from './panels/PlaceholderPanel';

const PANEL_TITLES: Record<string, string> = {
  explorer: 'Explorer',
  search: 'Search',
  git: 'Source Control',
  extensions: 'Extensions',
};

export function SidePanel() {
  const activePanelId = useAppStore((s) => s.activePanelId);
  const sidePanelWidth = useAppStore((s) => s.sidePanelWidth);

  if (!activePanelId) return null;

  const title = PANEL_TITLES[activePanelId] || activePanelId;

  return (
    <div
      className="flex-none flex flex-col h-full bg-primary border-r border-border overflow-hidden"
      style={{ width: sidePanelWidth }}
    >
      <div className="shrink-0 px-3.5 py-2.5 text-[11px] uppercase tracking-widest text-fg-muted border-b border-border">
        {title}
      </div>
      <div className="flex-1 overflow-y-auto">
        {activePanelId === 'explorer' && <ExplorerPanel />}
        {activePanelId === 'search' && <SearchPanel />}
        {(activePanelId === 'git' || activePanelId === 'extensions') && (
          <PlaceholderPanel panelId={activePanelId} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/SidePanel.tsx
git commit -m "feat: create SidePanel container component"
```

---

### Task 8: Integrate into App.tsx layout

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add imports**

At the top of `src/renderer/App.tsx`, add imports for the new components and store selectors:

```typescript
import { ActivityBar } from './components/ActivityBar';
import { SidePanel } from './components/SidePanel';
```

- [ ] **Step 2: Add side panel resize state and handler**

Inside the `App` component, after the existing `handleResizeStart` callback (around line 71), add store selectors and a new resize handler:

```typescript
const activePanelId = useAppStore((s) => s.activePanelId);
const setSidePanelWidth = useAppStore((s) => s.setSidePanelWidth);

const sidePanelDragging = useRef(false);

const handleSidePanelResizeStart = useCallback((e: React.MouseEvent) => {
  e.preventDefault();
  sidePanelDragging.current = true;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMove = (ev: MouseEvent) => {
    if (!sidePanelDragging.current || !contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();
    // 48px for the activity bar
    const newWidth = ev.clientX - rect.left - 48;
    setSidePanelWidth(newWidth);
  };

  const onUp = () => {
    sidePanelDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };

  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}, [setSidePanelWidth]);
```

- [ ] **Step 3: Update the JSX layout**

Replace the content area JSX (the `<div className="flex flex-1 overflow-hidden" ref={contentRef}>` block) with:

```tsx
<div className="flex flex-1 overflow-hidden" ref={contentRef}>
  <ActivityBar />
  {activePanelId && (
    <>
      <SidePanel />
      <div
        className="flex-[0_0_4px] cursor-col-resize bg-border transition-colors duration-[120ms] hover:bg-accent active:bg-accent"
        onMouseDown={handleSidePanelResizeStart}
      />
    </>
  )}
  <div
    className="flex-1 min-w-0"
    style={selectedSessionId ? { flex: `0 0 ${100 - terminalWidth}%` } : undefined}
  >
    <ReactFlowProvider>
      <GraphCanvas />
    </ReactFlowProvider>
  </div>
  {selectedSessionId && (
    <>
      <div
        className="flex-[0_0_4px] cursor-col-resize bg-border transition-colors duration-[120ms] hover:bg-accent active:bg-accent"
        onMouseDown={handleResizeStart}
      />
      <div className="min-w-0" style={{ flex: `0 0 ${terminalWidth}%` }}>
        <TerminalPanel />
      </div>
    </>
  )}
</div>
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run the app and visually verify**

Run: `pnpm start`
Expected:
- Activity bar appears on the far left with 4 icons
- Clicking Explorer icon opens side panel with "EXPLORER" header
- Clicking Search icon switches to search panel
- Clicking active icon collapses the panel
- Git and Extensions icons are dimmed and don't respond to clicks
- Side panel resize handle works (drag to resize between 160-400px)
- Graph canvas and terminal still work correctly

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: integrate activity bar and side panel into layout"
```

# Side Panel & Activity Bar

A VS Code-style activity bar and side panel for AgentPlex, providing a centralized management pane for sessions, file exploration, and search.

## Overview

Add a left-side activity bar (narrow icon strip) and collapsible side panel to AgentPlex. The panel hosts multiple views: Explorer, Session Explorer, Search, and placeholder panels for Git and Extensions (coming later).

### Layout

```
[ActivityBar 48px] [SidePanel resizable] [resize] [Graph Canvas flex] [resize] [Terminal Panel]
```

- Activity bar is always visible on the far left
- Side panel opens/closes by clicking activity bar icons (VS Code toggle behavior)
- Terminal panel remains independent on the right, unchanged
- Graph canvas fills remaining space

## Panels

### Explorer (functional)

Workspace-first tree view. Working directories are top-level folders, sessions are leaf nodes underneath.

```
EXPLORER
+-- agentplex/               <- last path segment, full path as tooltip
|   +-- Session 1            <- status dot + display name
|   +-- Session 2
+-- other-project/
    +-- Session 3
```

- Groups sessions by `cwd` field (derived from store, not stored separately)
- Clicking a session calls `selectSession(id)` (highlights on graph, opens terminal)
- Clicking a directory toggles expand/collapse (local component state)
- Status dots use existing `SessionStatus` color mapping

### Session Explorer (functional)

Flat list of all sessions regardless of directory.

```
SESSIONS
+-- Session 1    idle - agentplex
+-- Session 2    killed - agentplex
+-- Session 3    running - other-project
```

- Shows status, display name, directory name as secondary text
- Sorted by status: active sessions first, killed last
- Clicking a session calls `selectSession(id)`

### Search (functional)

Two-mode search panel with a segmented toggle.

```
SEARCH
[Sessions] [Files]
+------search query...------+
Results:
+-- Session 1: "matched line..."
+-- Session 2: "another match..."
```

**Session search:** Client-side string matching against `sessionBuffers` in the Zustand store. Strips ANSI codes before matching. Clicking a result calls `selectSession(id)`.

**File search:** New IPC channel `search:files` calls a recursive file search on the main process. Accepts `{ query: string, cwd: string }`, returns `{ file: string, line: number, text: string }[]`. Clicking a file result highlights which directory/session it belongs to.

### Git (placeholder)

Centered "Coming soon" message with dimmed git icon.

### Extensions (placeholder)

Centered "Coming soon" message with dimmed extensions icon.

## Architecture

### Approach: Monolithic Component

A single `SidePanel` component conditionally renders panel content based on `activePanelId`. No registry, no plugin system. Matches the existing codebase style of simple React + Zustand.

### New Files

| File | Purpose |
|------|---------|
| `src/renderer/components/ActivityBar.tsx` | Narrow icon strip, handles toggle logic |
| `src/renderer/components/SidePanel.tsx` | Container that renders the active panel |
| `src/renderer/components/panels/ExplorerPanel.tsx` | Workspace-first tree view |
| `src/renderer/components/panels/SessionExplorerPanel.tsx` | Flat session list |
| `src/renderer/components/panels/SearchPanel.tsx` | Search across sessions and files |
| `src/renderer/components/panels/PlaceholderPanel.tsx` | "Coming soon" for Git & Extensions |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add `cwd: string` to `SessionInfo` |
| `src/main/session-manager.ts` | Include `cwd` in `SessionInfo` returned by `create()`, `createWithUuid()`, `list()` |
| `src/renderer/store.ts` | Add `activePanelId`, `sidePanelWidth`, `togglePanel`, `setSidePanelWidth` |
| `src/renderer/App.tsx` | Insert activity bar + side panel into layout, add side panel resize handle |
| `src/renderer/types.ts` | Add `searchFiles` IPC method to `AgentPlexAPI` |
| `src/preload/preload.ts` | Expose `searchFiles` IPC bridge |
| `src/main/ipc-handlers.ts` | Handle `search:files` channel |
| `styles/index.css` | Styles for activity bar, side panel, tree views, search |

## State Management

### New Zustand Fields

```typescript
activePanelId: string | null;   // 'explorer' | 'sessions' | 'search' | 'git' | 'extensions' | null
sidePanelWidth: number;         // pixels, default 240

togglePanel: (panelId: string) => void;
setSidePanelWidth: (width: number) => void;
```

### Toggle Logic

- Click active panel icon -> `activePanelId = null` (collapse)
- Click different panel icon -> `activePanelId = newPanel` (switch)
- Click any icon when collapsed -> `activePanelId = panelId` (open)

### Explorer Data Derivation

```typescript
// Computed in ExplorerPanel, not stored
const tree = useMemo(() => {
  const groups: Record<string, SessionInfo[]> = {};
  for (const session of Object.values(sessions)) {
    (groups[session.cwd] ??= []).push(session);
  }
  return groups;
}, [sessions]);
```

## Styling

### Activity Bar
- 48px wide, full height below toolbar
- Background: `--bg-inset`
- Icons: 36x36px hit targets, 6px border-radius
- Active icon: `--bg-elevated` background + 2px left accent border
- Hover: subtle `--bg-elevated` background
- "Coming soon" icons: opacity 0.4

### Side Panel
- Default width: 240px (pixels, not percentage)
- Min: 160px, Max: 400px
- Background: `--bg-primary`
- Panel header: 11px uppercase, `--text-muted` color
- Tree items: 28px row height, 14px indent per level
- Selected item: `--accent` left border
- Hover: `--bg-elevated` background

### Resize Handle
- Same 4px pattern as existing graph/terminal resize handle
- Separate handler for side panel resize (pixel-based, clamped to 160-400px)

### Transitions
- Panel open/close: instant (no animation, matching VS Code)
- Hover states: 0.12s ease (matching existing codebase transitions)

### Theming
- All colors via existing CSS custom properties
- Works with dark and light themes automatically
- No new CSS variables needed

## IPC Changes

### `SessionInfo` Extension

```typescript
// ipc-channels.ts
export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  pid: number;
  cwd: string;  // NEW
}
```

### New Channel: `search:files`

```typescript
// Request
{ query: string; cwd: string }

// Response
{ file: string; line: number; text: string }[]
```

Recursive file search using `fs` on the main process. Respects common ignore patterns (node_modules, .git, dist). Returns first 100 matches.

## Edge Cases

- **Both panels open:** Graph canvas can get squeezed. No special handling — user controls both widths. Same as VS Code.
- **No sessions:** Explorer shows empty state message. Session Explorer shows empty state.
- **Session killed:** Stays in tree with killed status dot. Can still be clicked to view terminal output.
- **Multiple sessions same cwd:** All appear as siblings under the same directory node.

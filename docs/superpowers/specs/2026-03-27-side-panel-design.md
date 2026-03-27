# Side Panel & Activity Bar Design Spec

Rebuild of the side panel system from `user/zmohamed/projectexplorer`, now using pure Tailwind CSS. VS Code-style activity bar + collapsible side panel with Explorer and Search panels.

## Components

### ActivityBar (`src/renderer/components/ActivityBar.tsx`)

48px-wide vertical icon strip on the far left of the content area.

- **Icons:** Explorer (folder), Search (magnifying glass), Git (branch icon), Extensions (puzzle piece)
- **Behavior:** Click toggles the corresponding panel. Clicking the already-active icon collapses the side panel (`activePanelId = null`). Clicking a different icon switches panels.
- **Active state:** 2px accent left border indicator, `bg-elevated`, `text-fg`
- **Inactive state:** `text-fg-muted`, hover -> `bg-elevated`
- **Disabled (Git, Extensions):** 40% opacity, no pointer events
- **Styling:** `bg-inset`, `border-r border-border`, icons 36x36px with 6px border radius

### SidePanel (`src/renderer/components/SidePanel.tsx`)

Container between ActivityBar and graph canvas. Only renders when `activePanelId !== null`.

- **Width:** Default 240px, resizable 160-400px via drag handle
- **Header:** 11px uppercase label (`"EXPLORER"`, `"SEARCH"`), `text-fg-muted`, `tracking-widest`, `border-b border-border`
- **Content:** `overflow-y-auto`, fills remaining height
- **Background:** `bg-primary`, `border-r border-border`
- **Routes to:** ExplorerPanel, SearchPanel, or PlaceholderPanel based on `activePanelId`

### ExplorerPanel (`src/renderer/components/panels/ExplorerPanel.tsx`)

Workspace-first tree view. Sessions grouped by their working directory.

- **Directory rows:** Collapsible with chevron arrow (right/down). Shows last path segment. Full path in tooltip. `text-fg-muted`, `text-xs`.
- **Session rows:** Indented under directory. StatusIndicator dot + display name or session title. Click calls `selectSession(id)` to select on graph and open in terminal.
- **Selected row:** `bg-accent-subtle`, `border-l-2 border-accent`
- **Row sizing:** 28px height, `px-3.5`, hover -> `bg-elevated`
- **Empty state:** "No sessions yet" centered, `text-fg-muted`
- **Defaults:** All directories expanded. Collapse state is local (`useState`).
- **Data:** Tree computed via `useMemo` from `sessions` in store.

### SearchPanel (`src/renderer/components/panels/SearchPanel.tsx`)

Client-side session buffer search. No file search, no tabs.

- **Input:** Full-width text field, `bg-inset`, `border-border`, focus -> `border-accent`. Minimum 2 characters to trigger search.
- **Search logic:** Filters across `sessionBuffers` (ANSI-stripped via `stripAnsi()`). No debounce — instant matching.
- **Result rows:** `px-3.5 py-1.5`, hover -> `bg-elevated`. Session label in `text-fg-muted text-[11px]`, matched line in `text-fg text-xs`, truncated with ellipsis.
- **Click behavior:** Calls `selectSession(id)` to select the session on the graph and open it in the terminal panel.
- **Max results:** 5 per session
- **Empty state:** "No results" when query >= 2 chars but nothing matches

### PlaceholderPanel (`src/renderer/components/panels/PlaceholderPanel.tsx`)

For disabled panels (Git, Extensions).

- Centered layout: icon + label + "Coming soon" text
- `text-fg-muted`, icon at 40% opacity

## Store Changes (`src/renderer/store.ts`)

New state fields:

```typescript
activePanelId: PanelId | null  // default: null
sidePanelWidth: number         // default: 240
```

New type:

```typescript
type PanelId = 'explorer' | 'search' | 'git' | 'extensions'
```

New actions:

```typescript
togglePanel(panelId: PanelId): void
// - If activePanelId === panelId -> set null (collapse)
// - If activePanelId !== panelId -> set panelId (switch/open)

setSidePanelWidth(width: number): void
// - Clamp to 160-400px range
```

## Layout Changes (`src/renderer/App.tsx`)

Current layout: `[Toolbar] [GraphCanvas | Resize | TerminalPanel]`

New layout: `[Toolbar] [ActivityBar | SidePanel? | Resize? | GraphCanvas | Resize | TerminalPanel]`

- ActivityBar always visible (48px fixed, `flex-none`)
- SidePanel + resize handle conditionally rendered when `activePanelId !== null`
- Side panel resize handle: 4px strip, same pattern as existing terminal resize divider
- Resize handler: mousedown starts tracking, mousemove updates `sidePanelWidth`, mouseup cleans up. Cursor changes to `col-resize` during drag.

## New Files

```
src/renderer/components/ActivityBar.tsx
src/renderer/components/SidePanel.tsx
src/renderer/components/panels/ExplorerPanel.tsx
src/renderer/components/panels/SearchPanel.tsx
src/renderer/components/panels/PlaceholderPanel.tsx
```

## Modified Files

```
src/renderer/store.ts          — PanelId type, activePanelId, sidePanelWidth, togglePanel, setSidePanelWidth
src/renderer/App.tsx           — Layout restructure, ActivityBar + SidePanel integration, resize handler
```

## Styling Approach

Pure Tailwind utility classes — no new CSS in `index.css`. Uses existing theme tokens (`bg-inset`, `bg-elevated`, `bg-primary`, `text-fg`, `text-fg-muted`, `border-border`, `bg-accent-subtle`, `border-accent`, etc.) consistent with all other components in the codebase.

## Out of Scope

- File search (IPC-backed `SEARCH_FILES`)
- Git panel implementation
- Extensions panel implementation
- Animations/transitions on panel open/close

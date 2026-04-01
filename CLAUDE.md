# AgentPlex

Multi-session Claude/Codex/GitHub Copilot CLI orchestrator with interactive graph visualization. Electron desktop app that lets developers run multiple AI CLI sessions simultaneously, visualize them as draggable nodes on a canvas, and track sub-agents, plans, and tasks in real time.

## Tech Stack

- **Desktop**: Electron 41 + Node.js 20+
- **Frontend**: React 19, React Flow 12 (graph canvas), Zustand 5 (state), Tailwind CSS 4, xterm.js 6
- **Backend (main process)**: node-pty (terminal emulation), Claude SDK, file-based JSON persistence
- **Build**: Vite 8, TypeScript 6, electron-forge 7, pnpm 10.33

## Project Structure

```
src/
  main/                  # Electron main process
    main.ts              # App entry, window creation
    session-manager.ts   # PTY spawn, lifecycle, status tracking
    ipc-handlers.ts      # IPC bridge between main & renderer
    jsonl-session-watcher.ts  # Polls JSONL to detect sub-agent spawns
    plan-task-detector.ts     # Regex-based plan/task extraction from terminal output
    claude-session-scanner.ts # Discovers sessions from ~/.claude
    settings-manager.ts       # Persistent user preferences (AppPreferences type)
    sync-engine.ts            # Git-based settings sync (GitHub repo, profiles)
  preload/
    preload.ts           # Context bridge (window.agentPlex API)
  renderer/              # React app
    App.tsx              # Root component, IPC event subscriptions
    store.ts             # Zustand store (nodes, edges, sessions, UI state)
    components/
      GraphCanvas.tsx    # React Flow canvas with drag/drop, grouping
      SessionNode.tsx    # Session graph node (status, actions, rename)
      SubAgentNode.tsx   # Sub-agent child node
      GroupNode.tsx      # Container node for organizing sessions
      TerminalPanel.tsx  # xterm.js terminal view
      SendDialog.tsx     # Cross-session messaging with optional AI summarization
      ProjectLauncher.tsx # Modal for discovering & resuming sessions
      SettingsPanel.tsx  # JSON editor for settings, sync controls, profiles
      SyncConflictDialog.tsx # Monaco diff for sync conflict resolution
      Toolbar.tsx        # Top menu bar
  shared/                # Shared between main & renderer
    ipc-channels.ts      # IPC channel constants & types
    ansi-strip.ts        # ANSI escape removal
```

## Architecture

1. **Session lifecycle**: User creates session -> SessionManager spawns PTY (node-pty) running chosen CLI -> PTY output streams via IPC to renderer -> xterm.js renders terminal, Zustand store tracks state
2. **Sub-agent tracking**: JsonlSessionWatcher polls `~/.claude/projects/<path>/<uuid>.jsonl` for `tool_use` blocks with `name="Agent"` -> emits spawn/complete events -> rendered as child nodes on graph
3. **Plan/task detection**: PlanTaskDetector parses terminal output line-by-line with regex to detect plan mode transitions and task status changes
4. **Cross-session messaging**: SendDialog extracts recent terminal output from source session, optionally summarizes via Claude Haiku, writes to target session's PTY
5. **Persistence**: Session metadata saved to `~/.agentplex/state.json`, restored on app restart via `claude --resume <uuid>`
6. **Status detection**: Polls every 500ms, scans terminal buffer tail (ANSI-stripped) for prompt patterns to determine running/idle/waiting-for-input states

## Commands

```bash
pnpm install    # Install dependencies
pnpm start      # Dev mode with HMR
pnpm test       # Run tests (vitest)
pnpm test:watch # Run tests in watch mode
pnpm lint       # ESLint
pnpm package    # Package standalone app
pnpm make       # Build installer (.exe/.dmg/.deb)
```

## Key Concepts

- **Session**: A PTY running a CLI tool (claude/codex/copilot/bash) with status tracking and persistence
- **Sub-Agent**: Claude's spawned Agent tool calls, detected via JSONL polling, shown as child nodes
- **Plan/Task**: Claude CLI plan mode with individual tasks, parsed from terminal output
- **Group**: Container node created by dragging sessions together on the canvas
- **External Session**: Claude CLI sessions running outside AgentPlex, discoverable and adoptable
- **Settings Sync**: Git-based sync of preferences + Claude config across machines via a private GitHub repo, with profile support
- **Profile**: A named set of preferences + Claude config (default, work, personal, etc.) stored as folders in the sync repo

## Development Guidelines

### Testing (TDD)
- **All new features and bug fixes must have tests written first** (red-green-refactor).
- Test framework: **vitest** (`pnpm test` / `pnpm test:watch`).
- Test files live next to the module they test: `foo.ts` -> `foo.test.ts`.
- Main process code (settings-manager, sync-engine, etc.) is tested with temp directories and mocked `os.homedir()` / `electron`.
- Tests that interact with git use real bare repos in temp dirs — no mocking git itself.
- Run `pnpm test` and `npx tsc --noEmit` before considering any change complete.

### User-Configurable Settings
- **All user preferences and configurable values must be stored in `~/.agentplex/settings.json`** via `settings-manager.ts` (`updateSettings` / `getAllSettings`).
- Never hardcode user-facing defaults without a settings.json fallback. Read from `loadSettings()` first, fall back to a `DEFAULT_*` constant.
- The `AppPreferences` interface in `settings-manager.ts` uses `[key: string]: unknown` for extensibility — new settings do not require a migration.
- Settings are exposed to the renderer via the JSON editor in the Settings panel. Any new setting automatically appears there.
- Sync-related config (repo URL, active profile, claude include list) also lives in settings.json under `sync*` keys.
- The `syncClaudeIncludes` array controls which files/dirs from `~/.claude/` get synced. Default: `["CLAUDE.md", "settings.json", "agents", "commands", "plugins"]`.

### IPC Pattern
When adding a new feature that spans main + renderer:
1. Add types to `shared/ipc-channels.ts`
2. Add IPC channel constant to the `IPC` object
3. Add handler in `main/ipc-handlers.ts`
4. Add preload bridge method in `preload/preload.ts`
5. Add type to `AgentPlexAPI` in `renderer/types.ts`

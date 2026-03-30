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
    settings-manager.ts       # Persistent user preferences
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

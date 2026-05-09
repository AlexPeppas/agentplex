# AgentPlex

Multi-session desktop orchestrator for Claude, Copilot, Codex, and shell sessions, with graph-based visualization and live session metadata (sub-agents, plans, tasks, HITL state).

## Stack

- Electron 41, Node.js 20+
- React 19, React Flow 12, Zustand 5, Tailwind 4, xterm.js 6
- node-pty for terminal sessions
- Vite 8, TypeScript 6, electron-forge 7, pnpm 10

## Runtime Architecture

1. **Session lifecycle**: `session-manager.ts` spawns PTYs, streams output via IPC, tracks status, and persists resumable sessions in `~/.agentplex/state.json`.
2. **Resume parity**: Claude and Copilot both support launcher-based resume and restart restore via `resumeSessionId`.
3. **Sub-agent tracking**: `jsonl-session-watcher.ts` tails both:
   - Claude: `~/.claude/projects/<encoded-path>/<uuid>.jsonl`
   - Copilot: `~/.copilot/session-state/<uuid>/events.jsonl`
4. **Plan/task tracking**:
   - Claude: `plan-task-detector.ts` parses terminal output.
   - Copilot: watcher maps `session.plan_changed` and derives task lists from SQL todo operations in events.
5. **HITL detection**:
   - Prompt pattern detection from terminal output (generic)
   - Copilot permission events (`permission.requested/completed`) for fast waiting-state updates.
6. **Cross-session messaging**: `SendDialog.tsx` sends raw buffer context or optional Anthropic summary (`AGENTPLEX_API_KEY`).

## Key Main-Process Files

- `src/main/session-manager.ts`: PTY spawn/kill, resume, restore, status loop, external adoption
- `src/main/jsonl-session-watcher.ts`: Claude/Copilot event parsing for sub-agent/plan/task/HITL signals
- `src/main/claude-session-scanner.ts`: Claude project/session discovery + transcript rendering
- `src/main/copilot-session-scanner.ts`: Copilot project/session discovery + transcript rendering
- `src/main/ipc-handlers.ts`: renderer bridge for sessions, launcher, git, settings, templates

## UI Data Flow

- `App.tsx` subscribes to IPC events and updates Zustand store.
- `store.ts` is the source of truth for sessions, nodes, edges, plans, tasks, and sub-agents.
- `SessionNode.tsx` and `SubAgentNode.tsx` render live session/task/sub-agent state on the graph.

## Commands

```bash
pnpm install
pnpm start
pnpm lint
pnpm package
pnpm make
```

# AgentPlex

Multi-session Claude/Codex/Github CLI orchestrator with graph visualization.

## Features

- **Multi-session management** — run multiple Claude/Codex/GH CLI sessions side by side
- **Graph canvas** — drag, arrange, and connect session nodes on a visual canvas
- **Inline rename** — double-click any node to rename it
- **Cross-session messaging** — send messages between sessions with context summary for continuation
- **Sub-agent tracking** — visualize spawned sub-agents as child nodes
- **Plan & task visualization** — see plans and task lists rendered in the graph
- **Receive notifications when HITL is required** — receive notification when CLI requires human in the loop.

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or later
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-cli) installed and authenticated

## Quick Start

```bash
git clone https://github.com/anthropics/agentplex.git
cd agentplex
npm install
npm start
```

## Global Shortcut (optional)

Run `npm link` from the repo root to install a global `agentplex` command:

```bash
npm link        # one-time setup
agentplex       # launch from anywhere
```

To remove it later:

```bash
npm unlink -g agentplex
```

## Usage

1. **Create sessions** — click the "+" button to spawn a new Claude CLI session
2. **Arrange nodes** — drag session nodes freely on the canvas
3. **Rename** — double-click a node label to rename it
4. **Send messages** — use the cross-session messaging to coordinate between agents

## Tech Stack

- **Electron** — desktop shell
- **React** — UI framework
- **React Flow** — node graph canvas
- **xterm.js** — terminal emulation
- **Zustand** — state management
- **node-pty** — pseudo-terminal backend

## License

[MIT](LICENSE)

# Terminal Ctrl+C Copy-or-Interrupt Fix

## Problem

When text is selected in the xterm.js terminal and the user presses Ctrl+C, the keystroke is sent to the PTY as SIGINT (`^C`) instead of copying the selected text to the clipboard. Modern terminals (Windows Terminal, VS Code) copy selected text on Ctrl+C and only send SIGINT when no selection is present.

## Root Cause

The `attachCustomKeyEventHandler` in `useTerminal.ts` only intercepts Ctrl+/- for zoom. It returns `true` (pass-through) for all other Ctrl+ combinations, including Ctrl+C. This means xterm.js forwards the keystroke to the PTY unconditionally, regardless of whether text is selected.

The Electron Edit menu has a `{ role: 'copy' }` accelerator, but xterm.js captures the keypress before the Electron menu can handle it.

## Design

### Approach

Add a Ctrl+C intercept in the existing `attachCustomKeyEventHandler` in `src/renderer/hooks/useTerminal.ts`.

### Logic

In the custom key event handler, before the existing zoom handling:

1. Check if `e.ctrlKey && e.key === 'c' && e.type === 'keydown'`
2. If true, check `term.hasSelection()`
3. **Selection exists:** copy `term.getSelection()` to clipboard via `navigator.clipboard.writeText()`, call `term.clearSelection()`, call `e.preventDefault()`, return `false` (suppress keystroke)
4. **No selection:** return `true` (pass through to PTY as SIGINT)

### Behavior

| State | Ctrl+C Result |
|-------|--------------|
| Text selected | Copy to clipboard, clear selection, no SIGINT |
| No selection | SIGINT sent to shell (unchanged) |

### Why clearSelection

Matches Windows Terminal and VS Code behavior. After copying, the selection is dismissed so the next Ctrl+C sends SIGINT without requiring the user to manually deselect.

### Files Changed

- `src/renderer/hooks/useTerminal.ts` — add Ctrl+C check in `attachCustomKeyEventHandler`

No other files are modified. The Edit menu `{ role: 'copy' }` remains for non-terminal contexts.

### Testing

1. Open a terminal session
2. Run a command that produces output (e.g., `dir` or `ls`)
3. Select text with the mouse
4. Press Ctrl+C — verify text is copied to clipboard and selection clears
5. Press Ctrl+C again (no selection) — verify `^C` / SIGINT is sent to the shell
6. Run a long-running command (e.g., `ping localhost`)
7. Without selecting text, press Ctrl+C — verify the process is interrupted

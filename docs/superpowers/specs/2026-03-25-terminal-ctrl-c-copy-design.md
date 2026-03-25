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

In the custom key event handler, after the `!e.ctrlKey` early-return guard (line 94) but before the zoom size logic:

1. Check if `e.key === 'c'` (ctrlKey and keydown are already guarded)
2. If true, check `term.hasSelection()`
3. **Selection exists:** copy `term.getSelection()` to clipboard via `navigator.clipboard.writeText().catch(() => {})` (fire-and-forget with silent error handling since the handler must return synchronously), call `term.clearSelection()`, call `e.preventDefault()`, return `false` (suppress keystroke)
4. **No selection:** return `true` (pass through to PTY as SIGINT)

### Out of Scope

- **Ctrl+Shift+C:** Not handled; this is primarily a Windows/Mac Electron app where Ctrl+C is the standard copy shortcut.
- **Right-click context menu copy:** Separate concern handled by xterm.js/Electron natively.
- **Keyboard-based selection (Shift+arrow):** Requires xterm.js addon not currently in use.

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

**Basic copy flow:**
1. Open a terminal session, run a command that produces output (e.g., `dir`)
2. Select text with the mouse
3. Press Ctrl+C — verify text is copied to clipboard (paste into Notepad to confirm), selection clears
4. Press Ctrl+C again (no selection) — verify `^C` / SIGINT is sent to the shell

**SIGINT flow:**
5. Run a long-running command (e.g., `ping localhost`)
6. Without selecting text, press Ctrl+C — verify the process is interrupted

**Multi-line selection:**
7. Select text spanning multiple terminal lines
8. Press Ctrl+C — paste into Notepad and verify line breaks are preserved

**Word selection:**
9. Double-click a word to select it, press Ctrl+C — verify word is copied

**Rapid repeat:**
10. Select text, press Ctrl+C twice quickly — first copies, second sends SIGINT (no race condition)

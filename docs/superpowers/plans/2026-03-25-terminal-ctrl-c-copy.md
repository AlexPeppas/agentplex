# Terminal Ctrl+C Copy-or-Interrupt Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ctrl+C copy selected text in the xterm.js terminal (like modern terminals), and only send SIGINT when nothing is selected.

**Architecture:** Add a Ctrl+C intercept inside the existing `attachCustomKeyEventHandler` in `useTerminal.ts`. When `term.hasSelection()` is true, copy to clipboard and suppress the keystroke. Otherwise pass through as SIGINT.

**Tech Stack:** xterm.js, TypeScript, Electron renderer process, Clipboard API

**Spec:** `docs/superpowers/specs/2026-03-25-terminal-ctrl-c-copy-design.md`

---

## Chunk 1: Implementation

### Task 1: Add Ctrl+C copy-on-selection to the key handler

**Files:**
- Modify: `src/renderer/hooks/useTerminal.ts:93-104`

- [ ] **Step 1: Add the Ctrl+C intercept**

In `src/renderer/hooks/useTerminal.ts`, inside `attachCustomKeyEventHandler`, add the copy logic after the ctrlKey guard (line 94) and before the zoom size variable (line 95).

Replace lines 93-104:

```typescript
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (!e.ctrlKey || e.type !== 'keydown') return true;
      let newSize = terminalFontSize;
      if (e.key === '=' || e.key === '+') {
        newSize = Math.min(terminalFontSize + 2, MAX_FONT_SIZE);
      } else if (e.key === '-') {
        newSize = Math.max(terminalFontSize - 2, MIN_FONT_SIZE);
      } else if (e.key === '0') {
        newSize = DEFAULT_FONT_SIZE;
      } else {
        return true;
      }
```

With:

```typescript
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (!e.ctrlKey || e.type !== 'keydown') return true;

      // Ctrl+C: copy selected text or fall through as SIGINT
      if (e.key === 'c') {
        if (term.hasSelection()) {
          navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          term.clearSelection();
          e.preventDefault();
          return false;
        }
        return true;
      }

      let newSize = terminalFontSize;
      if (e.key === '=' || e.key === '+') {
        newSize = Math.min(terminalFontSize + 2, MAX_FONT_SIZE);
      } else if (e.key === '-') {
        newSize = Math.max(terminalFontSize - 2, MIN_FONT_SIZE);
      } else if (e.key === '0') {
        newSize = DEFAULT_FONT_SIZE;
      } else {
        return true;
      }
```

- [ ] **Step 2: Verify the app compiles and starts**

Run: `npm start` (invokes `electron-forge start`, which compiles TypeScript and launches the app)
Expected: No TypeScript errors in terminal output, app window opens. No new dependencies or imports are needed for this change.

- [ ] **Step 3: Manual test — copy with selection**

1. Start the app: `npm start`
2. Open a terminal session
3. Run `dir` (or `ls`) to produce output
4. Select text with the mouse
5. Press Ctrl+C
6. Expected: text is copied to clipboard (paste into Notepad to verify), selection clears, no `^C` in terminal

- [ ] **Step 4: Manual test — SIGINT without selection**

1. In the terminal, run `ping localhost`
2. Without selecting any text, press Ctrl+C
3. Expected: ping is interrupted, `^C` appears in terminal

- [ ] **Step 5: Manual test — rapid double Ctrl+C**

1. Select text, press Ctrl+C twice quickly
2. Expected: first press copies and clears selection, second sends SIGINT

- [ ] **Step 6: Manual test — word selection**

1. Double-click a word in the terminal output to select it
2. Press Ctrl+C, paste into Notepad
3. Expected: the word is copied correctly

- [ ] **Step 7: Manual test — multi-line selection**

1. Select text spanning multiple lines
2. Press Ctrl+C, paste into Notepad
3. Expected: line breaks are preserved in pasted text

- [ ] **Step 8: Commit**

```bash
git add src/renderer/hooks/useTerminal.ts
git commit -m "fix: Ctrl+C copies selected text instead of sending SIGINT

When text is selected in the terminal, Ctrl+C now copies the selection
to the clipboard and clears it (matching Windows Terminal / VS Code).
When nothing is selected, Ctrl+C sends SIGINT as before."
```

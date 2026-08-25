import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../store';

// Terminal always uses dark palette so text stays readable in both themes
const TERMINAL_THEME = {
  background: '#262420',
  foreground: '#ece4d8',
  cursor: '#ece4d8',
  selectionBackground: '#3e3830',
  black: '#1e1c18',
  red: '#e07070',
  green: '#a8c878',
  yellow: '#e8c070',
  blue: '#d18a7a',
  magenta: '#dfa898',
  cyan: '#d18a7a',
  white: '#9a8a70',
  brightBlack: '#4e4638',
  brightRed: '#e07070',
  brightGreen: '#a8c878',
  brightYellow: '#e8c070',
  brightBlue: '#dfa898',
  brightMagenta: '#dfa898',
  brightCyan: '#d18a7a',
  brightWhite: '#ece4d8',
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
let terminalFontSize = DEFAULT_FONT_SIZE;

interface LiveTerminal {
  term: Terminal;
  fitAddon: FitAddon;
  sessionId: string;
  lastCols: number;
  lastRows: number;
}

/** Registry of all live terminal instances — zoom/refresh apply to all of them. */
const liveTerminals = new Set<LiveTerminal>();

/** A terminal is "measurable" once it's attached and laid out with non-zero size.
 *  Fitting/refreshing a hidden (display:none / 0-size) terminal is wasteful and can
 *  produce bogus dimensions, so callers skip those until it becomes visible again. */
function isMeasurable(term: Terminal): boolean {
  const el = term.element;
  return !!el && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0;
}

/** Refit a terminal and push the size to its PTY. Skips hidden terminals and
 *  redundant resizes (unless `force`, used by wake/visibility recovery to
 *  reassert the PTY size even if our cached dimensions look unchanged). */
function syncTerminalSize(entry: LiveTerminal, force = false) {
  if (!isMeasurable(entry.term)) return;
  try {
    entry.fitAddon.fit();
  } catch {
    return;
  }
  const { cols, rows } = entry.term;
  if (cols <= 0 || rows <= 0) return;
  if (force || cols !== entry.lastCols || rows !== entry.lastRows) {
    entry.lastCols = cols;
    entry.lastRows = rows;
    try {
      window.agentPlex.resizeSession(entry.sessionId, cols, rows);
    } catch { /* ignore */ }
  }
}

/** Force every visible terminal to refit and fully repaint. This clears the
 *  stale xterm DOM-renderer viewport state that can appear after the OS sleeps,
 *  the window is minimized, or the tab is hidden for a long time — the bug where
 *  output scrolls into an "invisible ceiling" and is overwritten. */
function refreshAllTerminals() {
  for (const entry of liveTerminals) {
    if (!isMeasurable(entry.term)) continue;
    syncTerminalSize(entry, true);
    if (entry.term.rows > 0) {
      try {
        entry.term.clearTextureAtlas();
        entry.term.refresh(0, entry.term.rows - 1);
      } catch { /* ignore */ }
    }
  }
}

let refreshScheduled = false;
/** Coalesce bursts of wake/visibility/resize triggers into a single refresh on a
 *  later frame, giving layout/compositor state time to stabilize after wake. */
export function scheduleRefreshAllTerminals() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    refreshScheduled = false;
    refreshAllTerminals();
  }));
}

const TERMINAL_FONT_FAMILY = 'MesloLGS Nerd Font Mono';

/** xterm measures the character cell from the *currently loaded* font. The
 *  terminal font is a bundled @font-face (TTF) that may still be loading on the
 *  first paint, so an early fit() measures the fallback font's cell width and
 *  locks xterm's column count to it. Once the Nerd Font loads its glyph advance
 *  width differs, so xterm's cols no longer match the rendered glyphs and the
 *  PTY was told the wrong width — cursor-addressed TUI redraws (Copilot/Claude)
 *  then drift and overwrite themselves until a manual zoom/refit. Force the font
 *  to load, then refit + repaint so xterm and the PTY agree from the start. */
function fitWhenFontReady(entry: LiveTerminal) {
  // Best-effort immediate fit (correct when the font is already cached).
  requestAnimationFrame(() => syncTerminalSize(entry, true));

  const fonts = document.fonts;
  if (!fonts) return;

  const refit = () => {
    if (!liveTerminals.has(entry)) return; // unmounted
    syncTerminalSize(entry, true);
    if (entry.term.rows > 0) {
      try { entry.term.refresh(0, entry.term.rows - 1); } catch { /* ignore */ }
    }
  };

  // Explicitly load the weights xterm renders, then refit — covers the case
  // where nothing else has triggered the @font-face load yet.
  const size = entry.term.options.fontSize ?? DEFAULT_FONT_SIZE;
  Promise.all([
    fonts.load(`${size}px "${TERMINAL_FONT_FAMILY}"`).catch(() => undefined),
    fonts.load(`bold ${size}px "${TERMINAL_FONT_FAMILY}"`).catch(() => undefined),
  ]).then(refit);

  // Belt-and-suspenders: refit again once all document fonts settle.
  fonts.ready.then(refit).catch(() => undefined);
}

// Single set of global listeners (registered lazily, never removed — harmless)
let globalListenersRegistered = false;

function ensureGlobalListeners() {
  if (globalListenersRegistered) return;
  globalListenersRegistered = true;
  window.agentPlex.onZoom((direction) => {
    let newSize: number;
    if (direction === 'in') newSize = Math.min(terminalFontSize + 2, MAX_FONT_SIZE);
    else if (direction === 'out') newSize = Math.max(terminalFontSize - 2, MIN_FONT_SIZE);
    else newSize = DEFAULT_FONT_SIZE;
    if (newSize !== terminalFontSize) {
      terminalFontSize = newSize;
      for (const entry of liveTerminals) {
        entry.term.options.fontSize = newSize;
        syncTerminalSize(entry);
      }
    }
  });

  // When the window/tab becomes visible again (restore from minimize, tab switch),
  // xterm's renderer may be in a stale state — refit and repaint.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefreshAllTerminals();
  });

  // ResizeObserver only fires when the terminal's container changes size. A
  // display-scale/DPI or compositor change can invalidate xterm's cell metrics
  // without changing that box, so explicitly rebuild its renderer geometry.
  window.addEventListener('resize', scheduleRefreshAllTerminals);
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, sessionId: string) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    ensureGlobalListeners();

    // Create terminal
    const term = new Terminal({
      theme: TERMINAL_THEME,
      fontSize: terminalFontSize,
      fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    termRef.current = term;

    // Register in global set for zoom/refresh
    const entry: LiveTerminal = { term, fitAddon, sessionId, lastCols: 0, lastRows: 0 };
    liveTerminals.add(entry);

    // Fit once the terminal font is loaded so xterm's column count matches the
    // real glyph width (avoids progressive output misalignment mid-session).
    fitWhenFontReady(entry);

    // Cmd (macOS) or Ctrl (Windows/Linux) + key shortcuts
    const isMac = window.agentPlex.platform === 'darwin';
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (!modKey || e.type !== 'keydown') return true;

      // Cmd/Ctrl+C: copy only when there's actual selected text; otherwise fall
      // through so xterm sends SIGINT (\x03). Guard on a non-empty selection —
      // xterm can report hasSelection()===true for a zero-width selection left by
      // a plain click, which would otherwise silently swallow every Ctrl+C
      // (notably inside Copilot/Claude TUIs) and never interrupt the process.
      if (e.key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          window.agentPlex.clipboardWriteText(selection);
          term.clearSelection();
          e.preventDefault();
          return false;
        }
        return true;
      }

      // Cmd/Ctrl+V: paste from clipboard into terminal
      if (e.key === 'v') {
        const text = window.agentPlex.clipboardReadText();
        if (text) {
          term.paste(text);
        }
        e.preventDefault();
        return false;
      }

      let newSize: number;
      if (e.key === '=' || e.key === '+') {
        newSize = Math.min(terminalFontSize + 2, MAX_FONT_SIZE);
      } else if (e.key === '-') {
        newSize = Math.max(terminalFontSize - 2, MIN_FONT_SIZE);
      } else if (e.key === '0') {
        newSize = DEFAULT_FONT_SIZE;
      } else {
        return true;
      }
      if (newSize !== terminalFontSize) {
        terminalFontSize = newSize;
        // Apply to ALL live terminals
        for (const liveEntry of liveTerminals) {
          liveEntry.term.options.fontSize = newSize;
          syncTerminalSize(liveEntry);
        }
      }
      e.preventDefault();
      return false;
    });


    // Forward keystrokes to pty
    term.onData((data) => {
      window.agentPlex.writeSession(sessionId, data);
    });

    // Capture the buffer and subscribe in the same event-loop turn before
    // replaying it. Registering after term.write() left a window where busy PTY
    // output reached Zustand but was permanently absent from this xterm pane.
    const buffer = useAppStore.getState().sessionBuffers[sessionId];
    const cleanup = window.agentPlex.onSessionData(({ id, data }) => {
      if (id === sessionId && termRef.current) {
        termRef.current.write(data);
      }
    });
    if (buffer) {
      term.write(buffer);
    }

    // Handle resize
    let disposed = false;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      syncTerminalSize(entry);
    });
    resizeObserver.observe(containerRef.current);

    // Right-click to paste
    const container = containerRef.current;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const text = window.agentPlex.clipboardReadText();
      if (text) {
        term.paste(text);
      }
    };
    container.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposed = true;
      liveTerminals.delete(entry);
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      cleanup();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]); // intentionally only depend on session change
}

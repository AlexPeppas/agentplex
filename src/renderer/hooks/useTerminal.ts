import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../store';
import { createTerminalResizeController } from '../terminal-resize';
import { terminalArtifactReferences } from '../../shared/artifact-links';

// Terminal always uses dark palette so text stays readable in both themes
const TERMINAL_THEME = {
  background: '#121619',
  foreground: '#e4e8ed',
  cursor: '#e4e8ed',
  selectionBackground: '#343b43',
  black: '#15181c',
  red: '#d69c9c',
  green: '#a4b9ac',
  yellow: '#cfb991',
  blue: '#9fb5ce',
  magenta: '#b6a6c9',
  cyan: '#9dbfbd',
  white: '#c5cdd6',
  brightBlack: '#8a96a3',
  brightRed: '#e4b2b2',
  brightGreen: '#b8cdc0',
  brightYellow: '#e0cba5',
  brightBlue: '#b4c8df',
  brightMagenta: '#cbbbdc',
  brightCyan: '#b3d2d0',
  brightWhite: '#e4e8ed',
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
let terminalFontSize = DEFAULT_FONT_SIZE;

interface LiveTerminal {
  term: Terminal;
  resize: ReturnType<typeof createTerminalResizeController>;
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

/** Queue a refit and push the settled size to its PTY. Skips hidden terminals and
 *  redundant resizes (unless `force`, used by wake/visibility recovery to
 *  reassert the PTY size even if our cached dimensions look unchanged). */
function syncTerminalSize(entry: LiveTerminal, force = false) {
  entry.resize.schedule(force);
}

/** Force every visible terminal to refit and fully repaint. This clears the
 *  stale xterm DOM-renderer viewport state that can appear after the OS sleeps,
 *  the window is minimized, or the tab is hidden for a long time — the bug where
 *  output scrolls into an "invisible ceiling" and is overwritten. */
function refreshAllTerminals() {
  for (const entry of liveTerminals) {
    if (!isMeasurable(entry.term)) continue;
    syncTerminalSize(entry, true);
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
 * terminal font may still be loading on first paint, so refit once its actual
 * metrics are available to keep xterm columns synchronized with the PTY. */
function fitWhenFontReady(entry: LiveTerminal) {
  syncTerminalSize(entry);

  const fonts = document.fonts;
  if (!fonts) return;

  const refit = () => {
    if (!liveTerminals.has(entry)) return;
    syncTerminalSize(entry);
  };

  const size = entry.term.options.fontSize ?? DEFAULT_FONT_SIZE;
  Promise.all([
    fonts.load(`${size}px "${TERMINAL_FONT_FAMILY}"`).catch(() => undefined),
    fonts.load(`bold ${size}px "${TERMINAL_FONT_FAMILY}"`).catch(() => undefined),
  ]).then(refit);
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
  window.addEventListener('resize', scheduleRefreshAllTerminals);
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, sessionId: string, onOpenFile?: (reference: string) => void) {
  const openFileRef = useRef(onOpenFile);
  useEffect(() => { openFileRef.current = onOpenFile; }, [onOpenFile]);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const buffersReady = useAppStore(s => s.buffersReady);

  useEffect(() => {
    if (!containerRef.current || !sessionId || !buffersReady) return;

    ensureGlobalListeners();

    // Create terminal
    const term = new Terminal({
      disableStdin: useAppStore.getState().sessions[sessionId]?.readOnly === true,
      theme: TERMINAL_THEME,
      fontSize: terminalFontSize,
      fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
      windowsPty: useAppStore.getState().sessions[sessionId]?.windowsPty,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: (_event, uri) => {
          if (/^https?:/i.test(uri)) {
            window.agentPlex.openExternal(uri).catch(error => console.error('[terminal] Cannot open link:', error));
          } else if (/^file:/i.test(uri) || !/^[a-z][a-z\d+.-]*:/i.test(uri) || /^[a-z]:[\\/]/i.test(uri)) {
            openFileRef.current?.(uri);
          } else console.warn('[terminal] Unsupported link protocol:', uri);
        },
      },
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    term.registerLinkProvider({
      provideLinks: (line, callback) => {
        callback(terminalArtifactReferences(term.buffer.active, term.cols, line).map(link => ({
          range: link.range,
          text: link.reference,
          activate: () => openFileRef.current?.(link.reference),
        })));
      },
    });

    termRef.current = term;

    // Register in global set for zoom/refresh
    const entry: LiveTerminal = {
      term,
      resize: createTerminalResizeController(term, fitAddon, containerRef.current,
        (cols, rows) => window.agentPlex.resizeSession(sessionId, cols, rows)),
    };
    liveTerminals.add(entry);

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
      if (!useAppStore.getState().sessions[sessionId]?.readOnly) window.agentPlex.writeSession(sessionId, data);
    });

    // Capture and subscribe in one event-loop turn so live output cannot fall
    // between buffer replay and listener registration.
    const replayState = useAppStore.getState();
    const buffer = replayState.sessionBuffers[sessionId];
    let outputOffset = replayState.sessionBufferOffsets[sessionId] ?? buffer?.length ?? 0;
    const cleanup = window.agentPlex.onSessionData(({ id, data, offset }) => {
      if (id === sessionId && termRef.current) {
        const end = offset ?? outputOffset + data.length;
        if (end <= outputOffset) return;
        const delta = data.slice(Math.max(0, outputOffset - (end - data.length)));
        outputOffset = end;
        if (delta) termRef.current.write(delta);
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
      entry.resize.dispose();
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      cleanup();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, buffersReady]); // intentionally exclude the stable container ref
}

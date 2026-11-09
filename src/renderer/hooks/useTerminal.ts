import { useEffect, useRef, useState } from 'react';
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
      document.documentElement.style.setProperty('--terminal-font-size', `${newSize}px`);
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

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, sessionId: string, onOpenFile?: (reference: string) => void, enabled = true) {
  const [restoration, setRestoration] = useState(0);
  const openFileRef = useRef(onOpenFile);
  useEffect(() => { openFileRef.current = onOpenFile; }, [onOpenFile]);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const buffersReady = useAppStore(s => s.buffersReady);

  useEffect(() => {
    ensureGlobalListeners();
    if (!enabled || !containerRef.current || !sessionId || !buffersReady) return;

    // Create terminal
    const term = new Terminal({
      disableStdin: useAppStore.getState().sessions[sessionId]?.readOnly === true,
      theme: TERMINAL_THEME,
      fontSize: terminalFontSize,
      fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
      cursorBlink: true,
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
        const artifacts = terminalArtifactReferences(term.buffer.active, term.cols, line).map(link => ({
          range: link.range,
          text: link.reference,
          activate: () => openFileRef.current?.(link.reference),
        }));
        if (useAppStore.getState().sessions[sessionId]?.readOnly) { callback(artifacts); return; }
        window.agentPlex.getTerminalLinks(sessionId, line).then(links => {
          if (termRef.current !== term) { callback([]); return; }
          const row = term.buffer.active.getLine(line - 1);
          callback([...links.filter(link => row?.translateToString(false, link.start - 1, link.end) === link.text).map(link => {
            const range = { start: { x: link.start, y: line }, end: { x: link.end, y: line } };
            return { range, text: link.text, activate: (event: MouseEvent) =>
              term.options.linkHandler?.activate(event, link.uri, range) };
          }), ...artifacts]);
        }).catch(error => {
          if (termRef.current !== term) { callback([]); return; }
          console.error('[terminal] Cannot restore terminal links:', error);
          callback(artifacts);
        });
      },
    });

    termRef.current = term;
    let replaying = true;
    const clipboardHandler = term.parser.registerOscHandler(52, async data => {
      const session = useAppStore.getState().sessions[sessionId];
      if (replaying || termRef.current !== term || !isMeasurable(term) || !session || session.readOnly) return true;
      const separator = data.indexOf(';');
      const selection = data.slice(0, separator);
      const encoded = data.slice(separator + 1);
      if (separator < 0 || (selection !== '' && selection !== 'c') || encoded === '?') {
        console.warn('[terminal] Unsupported clipboard selection or read request');
        return true;
      }
      if (encoded.length > 4 * Math.ceil(1024 * 1024 / 3)) {
        console.warn('[terminal] Clipboard escape sequence exceeds the 1 MiB limit');
        return true;
      }
      try {
        const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
        if (bytes.length > 1024 * 1024) throw new Error('Clipboard text exceeds the 1 MiB limit');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        await window.agentPlex.clipboardWriteText(text);
      } catch (error) {
        console.error('[terminal] Cannot copy CLI clipboard text:', error);
      }
      return true;
    });

    // Register in global set for zoom/refresh
    const entry: LiveTerminal = {
      term,
      resize: createTerminalResizeController(term, fitAddon, containerRef.current,
        (cols, rows) => {
          resizing = true;
          resizeBoundary = null;
          return window.agentPlex.resizeSession(sessionId, cols, rows);
        }, {
          beforeResize: async offset => {
            resizeBoundary = offset;
            const events = resizePending;
            resizePending = [];
            queuedLength = 0;
            for (const event of events) writeResizeOutput(event.data, event.offset);
            if (outputOffset < offset) await new Promise<void>((resolve, reject) => { resizeWaiter = { resolve, reject }; });
            await new Promise<void>(resolve => term.write('', resolve));
          },
          afterResize: () => {
            if (disposed) return;
            resizing = false;
            resizeBoundary = null;
            const events = resizePending;
            resizePending = [];
            queuedLength = 0;
            for (const event of events) writeOutput(event.data, event.offset);
          },
        }),
    };
    let disposed = false;

    // Cmd (macOS) or Ctrl (Windows/Linux) + key shortcuts
    const isMac = window.agentPlex.platform === 'darwin';
    const copySelection = (selection: string) => {
      window.agentPlex.clipboardWriteText(selection)
        .then(() => {
          if (liveTerminals.has(entry) && term.getSelection() === selection) term.clearSelection();
        })
        .catch(error => console.error('[terminal] Cannot copy selected text:', error));
    };
    const pasteClipboard = () => {
      if (useAppStore.getState().sessions[sessionId]?.readOnly) return;
      window.agentPlex.clipboardReadText()
        .then(text => {
          if (text && liveTerminals.has(entry) && !useAppStore.getState().sessions[sessionId]?.readOnly) term.paste(text);
        })
        .catch(error => console.error('[terminal] Cannot paste clipboard text:', error));
    };
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (!modKey || e.type !== 'keydown') return true;
      const key = e.key.toLowerCase();

      // Cmd/Ctrl+C: copy only when there's actual selected text; otherwise fall
      // through so xterm sends SIGINT (\x03). Guard on a non-empty selection —
      // xterm can report hasSelection()===true for a zero-width selection left by
      // a plain click, which would otherwise silently swallow every Ctrl+C
      // (notably inside Copilot/Claude TUIs) and never interrupt the process.
      if (key === 'c') {
        const selection = term.getSelection();
        if (selection) {
          copySelection(selection);
          e.preventDefault();
          return false;
        }
        if (e.shiftKey) {
          e.preventDefault();
          return false;
        }
        return true;
      }

      // Cmd/Ctrl+V: paste from clipboard into terminal
      if (key === 'v') {
        pasteClipboard();
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
      if (!disposed && !useAppStore.getState().sessions[sessionId]?.readOnly) window.agentPlex.writeSession(sessionId, data);
    });

    let outputOffset = 0;
    let pending: { data: string; offset: number }[] = [];
    let resizing = false;
    let resizeBoundary: number | null = null;
    let resizePending: { data: string; offset: number }[] = [];
    let resizeWaiter: { resolve: () => void; reject: (error: Error) => void } | null = null;
    let queuedLength = 0;
    const enqueue = (queue: { data: string; offset: number }[], event: { data: string; offset: number }) => {
      queuedLength += event.data.length;
      if (queuedLength <= 2 * 1024 * 1024) { queue.push(event); return; }
      disposed = true;
      replaying = true;
      entry.resize.dispose();
      liveTerminals.delete(entry);
      resizeWaiter?.reject(new Error('Terminal restoration was restarted'));
      pending = []; resizePending = [];
      queuedLength = 0;
      console.error('[terminal] Output exceeded the terminal restoration queue limit:', sessionId);
      if (restoration < 3) setRestoration(value => value + 1);
      else {
        term.write('\x18\r\n[Output changed too quickly to restore this view. Close and reopen the pane.]\r\n');
      }
    };
    const writeOutput = (data: string, offset: number) => {
        if (disposed) return;
        const end = offset ?? outputOffset + data.length;
        if (end <= outputOffset) return;
        const delta = data.slice(Math.max(0, outputOffset - (end - data.length)));
        outputOffset = end;
        if (delta) term.write(delta);
    };
    const writeResizeOutput = (data: string, offset: number) => {
      if (disposed) return;
      if (resizeBoundary === null) { enqueue(resizePending, { data, offset }); return; }
      const length = Math.max(0, Math.min(data.length, resizeBoundary - (offset - data.length)));
      if (length) writeOutput(data.slice(0, length), offset - data.length + length);
      if (length < data.length) enqueue(resizePending, { data: data.slice(length), offset });
      if (outputOffset >= resizeBoundary) { resizeWaiter?.resolve(); resizeWaiter = null; }
    };
    // Subscribe before requesting the parsed screen; replay at its original
    // geometry, drain the live suffix, then synchronize the visible pane.
    const cleanup = window.agentPlex.onSessionData(({ id, data, offset }) => {
      if (id !== sessionId || disposed) return;
      if (replaying) enqueue(pending, { data, offset });
      else if (resizing) writeResizeOutput(data, offset);
      else writeOutput(data, offset);
    });
    const finishReplay = () => {
      if (disposed) return;
      if (pending.length) {
        const events = pending;
        pending = [];
        queuedLength = 0;
        for (const event of events) writeOutput(event.data, event.offset);
        term.write('', finishReplay);
        return;
      }
      replaying = false;
      liveTerminals.add(entry);
      entry.resize.initialize();
      fitWhenFontReady(entry);
    };
    window.agentPlex.getTerminalSnapshot(sessionId).then(snapshot => {
      if (disposed) return;
      outputOffset = snapshot.offset;
      term.resize(snapshot.cols, snapshot.rows);
      term.write(snapshot.buffer + '\x18' + (snapshot.pendingSequence ?? ''), finishReplay);
    }).catch(error => {
      if (disposed) return;
      console.error('[terminal] Cannot restore terminal state:', sessionId, error);
      pending = [];
      queuedLength = 0;
      disposed = true;
      term.write('\r\n[Cannot restore this terminal view. Close and reopen the pane.]\r\n');
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (disposed || replaying) return;
      syncTerminalSize(entry);
    });
    resizeObserver.observe(containerRef.current);

    // Preserve terminal selection when copying; otherwise right-click pastes.
    const container = containerRef.current;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const selection = term.getSelection();
      if (selection) copySelection(selection);
      else pasteClipboard();
    };
    container.addEventListener('contextmenu', handleContextMenu);

    return () => {
      disposed = true;
      resizeWaiter?.reject(new Error('Terminal pane was closed'));
      liveTerminals.delete(entry);
      entry.resize.dispose();
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      cleanup();
      clipboardHandler.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId, buffersReady, enabled, restoration]); // intentionally exclude the stable container ref
}

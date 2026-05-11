import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../store';
import { getTerminalThemeDef, subscribeTerminalTheme } from '../terminalThemes';

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
let terminalFontSize = DEFAULT_FONT_SIZE;

/** Registry of all live terminal instances — zoom applies to all of them. */
const liveTerminals = new Set<{ term: Terminal; fitAddon: FitAddon; sessionId: string }>();

// Single global zoom listener (registered lazily, never removed — harmless)
let zoomListenerRegistered = false;

function ensureGlobalZoomListener() {
  if (zoomListenerRegistered) return;
  zoomListenerRegistered = true;
  window.agentPlex.onZoom((direction) => {
    let newSize: number;
    if (direction === 'in') newSize = Math.min(terminalFontSize + 2, MAX_FONT_SIZE);
    else if (direction === 'out') newSize = Math.max(terminalFontSize - 2, MIN_FONT_SIZE);
    else newSize = DEFAULT_FONT_SIZE;
    if (newSize !== terminalFontSize) {
      terminalFontSize = newSize;
      for (const entry of liveTerminals) {
        entry.term.options.fontSize = newSize;
        try {
          entry.fitAddon.fit();
          window.agentPlex.resizeSession(entry.sessionId, entry.term.cols, entry.term.rows);
        } catch { /* ignore */ }
      }
    }
  });
}

// Single global theme subscription — pushes palette changes to all live terminals.
let themeListenerRegistered = false;

function ensureGlobalThemeListener() {
  if (themeListenerRegistered) return;
  themeListenerRegistered = true;
  subscribeTerminalTheme((def) => {
    for (const entry of liveTerminals) {
      entry.term.options.theme = def.theme;
    }
  });
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, sessionId: string) {
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    ensureGlobalZoomListener();
    ensureGlobalThemeListener();

    // Create terminal
    const term = new Terminal({
      theme: getTerminalThemeDef().theme,
      fontSize: terminalFontSize,
      fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);

    // Fit after a frame to get correct dimensions
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        window.agentPlex.resizeSession(sessionId, term.cols, term.rows);
      } catch {
        // container might not be ready
      }
    });

    termRef.current = term;

    // Register in global set for zoom
    const entry = { term, fitAddon, sessionId };
    liveTerminals.add(entry);

    // Cmd (macOS) or Ctrl (Windows/Linux) + key shortcuts
    const isMac = window.agentPlex.platform === 'darwin';
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (!modKey || e.type !== 'keydown') return true;

      // Cmd/Ctrl+C: copy selected text or fall through as SIGINT
      if (e.key === 'c') {
        if (term.hasSelection()) {
          window.agentPlex.clipboardWriteText(term.getSelection());
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
        for (const e of liveTerminals) {
          e.term.options.fontSize = newSize;
          try {
            e.fitAddon.fit();
            window.agentPlex.resizeSession(e.sessionId, e.term.cols, e.term.rows);
          } catch { /* ignore */ }
        }
      }
      e.preventDefault();
      return false;
    });


    // Write buffered output
    const buffer = useAppStore.getState().sessionBuffers[sessionId];
    if (buffer) {
      term.write(buffer);
    }

    // Forward keystrokes to pty
    term.onData((data) => {
      window.agentPlex.writeSession(sessionId, data);
    });

    // Subscribe to pty output — filter by this pane's sessionId
    const cleanup = window.agentPlex.onSessionData(({ id, data }) => {
      if (id === sessionId && termRef.current) {
        termRef.current.write(data);
      }
    });

    // Handle resize
    let disposed = false;
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      try {
        fitAddon.fit();
        window.agentPlex.resizeSession(sessionId, term.cols, term.rows);
      } catch {
        // ignore
      }
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

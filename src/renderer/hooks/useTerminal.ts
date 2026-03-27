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

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current || !selectedSessionId) return;

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

    // Fit after a frame to get correct dimensions
    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        if (selectedSessionId) {
          window.agentPlex.resizeSession(
            selectedSessionId,
            term.cols,
            term.rows
          );
        }
      } catch {
        // container might not be ready
      }
    });

    termRef.current = term;

    // Cmd (macOS) or Ctrl (Windows/Linux) + key shortcuts
    const sessionId_ = selectedSessionId;
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
        term.options.fontSize = newSize;
        try {
          fitAddon.fit();
          window.agentPlex.resizeSession(sessionId_, term.cols, term.rows);
        } catch { /* ignore */ }
      }
      e.preventDefault();
      return false;
    });


    // Write buffered output
    const buffer = useAppStore.getState().sessionBuffers[selectedSessionId];
    if (buffer) {
      term.write(buffer);
    }

    // Forward keystrokes to pty
    const sessionId = selectedSessionId;
    term.onData((data) => {
      window.agentPlex.writeSession(sessionId, data);
    });

    // Subscribe to pty output
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
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      cleanup();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [selectedSessionId]); // intentionally only depend on session change
}

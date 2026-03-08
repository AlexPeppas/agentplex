import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../store';

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!containerRef.current || !selectedSessionId) return;

    // Create terminal
    const term = new Terminal({
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      fontSize: 14,
      fontFamily: 'Cascadia Code, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
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
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        window.agentPlex.resizeSession(sessionId, term.cols, term.rows);
      } catch {
        // ignore
      }
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      cleanup();
      term.dispose();
      termRef.current = null;
    };
  }, [selectedSessionId]); // intentionally only depend on session change
}

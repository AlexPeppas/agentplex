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
        background: '#262624',
        foreground: '#e6dace',
        cursor: '#e6dace',
        selectionBackground: '#3a3a38',
        black: '#1e1e1c',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#d18a7a',
        magenta: '#be7868',
        cyan: '#c9806e',
        white: '#d0c4b4',
        brightBlack: '#4e4e4a',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#dba090',
        brightMagenta: '#be7868',
        brightCyan: '#c9806e',
        brightWhite: '#e6dace',
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

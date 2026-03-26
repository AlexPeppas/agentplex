import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../store';

function getCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function buildTerminalTheme() {
  const bg = getCssVar('--bg-primary') || '#262420';
  const fg = getCssVar('--text-primary') || '#ece4d8';
  const muted = getCssVar('--text-muted') || '#9a8a70';
  const border = getCssVar('--border') || '#3e3830';
  const accent = getCssVar('--accent') || '#d18a7a';
  const accentHover = getCssVar('--accent-hover') || '#dfa898';
  const success = getCssVar('--success') || '#a8c878';
  const warning = getCssVar('--warning') || '#e8c070';
  const error = getCssVar('--error') || '#e07070';

  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    selectionBackground: border,
    black: getCssVar('--bg-inset') || '#1e1c18',
    red: error,
    green: success,
    yellow: warning,
    blue: accent,
    magenta: accentHover,
    cyan: accent,
    white: muted,
    brightBlack: getCssVar('--border-strong') || '#4e4638',
    brightRed: error,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: accentHover,
    brightMagenta: accentHover,
    brightCyan: accent,
    brightWhite: fg,
  };
}

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
      theme: buildTerminalTheme(),
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

    // Update terminal theme when data-theme attribute changes
    const observer = new MutationObserver(() => {
      if (termRef.current) {
        termRef.current.options.theme = buildTerminalTheme();
      }
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
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
    const resizeObserver = new ResizeObserver(() => {
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
      container.removeEventListener('contextmenu', handleContextMenu);
      observer.disconnect();
      resizeObserver.disconnect();
      cleanup();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [selectedSessionId]); // intentionally only depend on session change
}

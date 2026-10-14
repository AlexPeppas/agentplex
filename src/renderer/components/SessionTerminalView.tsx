import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useCurrentTheme } from '../hooks/useTheme';

const TERMINAL_THEME_DARK = {
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

const TERMINAL_THEME_LIGHT = {
  background: '#ebe5da',
  foreground: '#3a3428',
  cursor: '#3a3428',
  selectionBackground: '#d8d0c4',
  black: '#3a3428',
  red: '#c44040',
  green: '#4a8a40',
  yellow: '#b8922a',
  blue: '#c06a50',
  magenta: '#a85a42',
  cyan: '#c06a50',
  white: '#8a7e6e',
  brightBlack: '#8a7e6e',
  brightRed: '#c44040',
  brightGreen: '#4a8a40',
  brightYellow: '#b8922a',
  brightBlue: '#d07a60',
  brightMagenta: '#a85a42',
  brightCyan: '#c06a50',
  brightWhite: '#3a3428',
};

const DEFAULT_FONT_SIZE = 14;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

interface Props {
  sessionId: string;
  isVisible: boolean;
}

export function SessionTerminalView({ sessionId, isVisible }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const currentTheme = useCurrentTheme();
  const fontSizeRef = useRef(DEFAULT_FONT_SIZE);
  const lastCols = useRef(0);
  const lastRows = useRef(0);

  const fitTerminal = useCallback(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon || !containerRef.current) return;
    const el = term.element;
    if (!el || el.offsetParent === null || el.clientWidth <= 0 || el.clientHeight <= 0) return;

    try {
      fitAddon.fit();
      const { cols, rows } = term;
      if (cols > 0 && rows > 0 && (cols !== lastCols.current || rows !== lastRows.current)) {
        lastCols.current = cols;
        lastRows.current = rows;
        window.agentPlex.resizeSessionTerminal(sessionId, cols, rows);
      }
    } catch {
      // ignore fit errors during transitions
    }
  }, [sessionId]);

  // Update theme dynamically when theme changes
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = currentTheme === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK;
    }
  }, [currentTheme]);

  // Refit when becoming visible
  useEffect(() => {
    if (isVisible) {
      requestAnimationFrame(() => {
        fitTerminal();
        termRef.current?.focus();
      });
    }
  }, [isVisible, fitTerminal]);

  useEffect(() => {
    if (!containerRef.current || !sessionId) return;

    const term = new Terminal({
      theme: currentTheme === 'light' ? TERMINAL_THEME_LIGHT : TERMINAL_THEME_DARK,
      fontSize: fontSizeRef.current,
      fontFamily: 'MesloLGS Nerd Font Mono, Menlo, Monaco, Cascadia Code, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    termRef.current = term;

    try {
      fitAddon.fit();
    } catch {
      // ignore
    }
    const initialCols = term.cols > 0 ? term.cols : 120;
    const initialRows = term.rows > 0 ? term.rows : 30;

    // Open or connect to terminal in backend with measured dimensions
    window.agentPlex.openSessionTerminal(sessionId, initialCols, initialRows).catch(console.error);

    let initialBufferLoaded = false;
    const earlyChunks: string[] = [];

    // Load initial buffer, sanitizing any stale leading % mark
    window.agentPlex
      .getSessionTerminalBuffer(sessionId)
      .then((buf) => {
        if (buf && termRef.current) {
          // eslint-disable-next-line no-control-regex
          const cleanBuf = buf.replace(/^(?:\x1b\[[0-9;]*m)*%(?:\x1b\[[0-9;]*m)*\s*(\r|\n)+\s*/, '');
          termRef.current.write(cleanBuf);
        }
      })
      .catch(console.error)
      .finally(() => {
        initialBufferLoaded = true;
        if (termRef.current) {
          for (const chunk of earlyChunks) {
            termRef.current.write(chunk);
          }
        }
        earlyChunks.length = 0;
      });

    // Stream live data
    const cleanupData = window.agentPlex.onSessionTerminalData(({ sessionId: id, data }) => {
      if (id === sessionId && termRef.current) {
        if (!initialBufferLoaded) {
          earlyChunks.push(data);
        } else {
          termRef.current.write(data);
        }
      }
    });

    const cleanupExit = window.agentPlex.onSessionTerminalExit(({ sessionId: id }) => {
      if (id === sessionId && termRef.current) {
        termRef.current.writeln('\r\n[Shell exited]');
      }
    });

    // Send user input to shell
    const dataDisposable = term.onData((data) => {
      window.agentPlex.writeSessionTerminal(sessionId, data);
    });

    // Keyboard shortcuts: copy/paste and zoom
    const isMac = window.agentPlex.platform === 'darwin';
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (!modKey || e.type !== 'keydown') return true;

      // Copy
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

      // Paste
      if (e.key === 'v') {
        const text = window.agentPlex.clipboardReadText();
        if (text) {
          term.paste(text);
        }
        e.preventDefault();
        return false;
      }

      // Zoom
      if (e.key === '=' || e.key === '+') {
        fontSizeRef.current = Math.min(fontSizeRef.current + 2, MAX_FONT_SIZE);
      } else if (e.key === '-') {
        fontSizeRef.current = Math.max(fontSizeRef.current - 2, MIN_FONT_SIZE);
      } else if (e.key === '0') {
        fontSizeRef.current = DEFAULT_FONT_SIZE;
      } else {
        return true;
      }

      term.options.fontSize = fontSizeRef.current;
      fitTerminal();
      e.preventDefault();
      return false;
    });

    // Global zoom listener
    const cleanupZoom = window.agentPlex.onZoom((direction) => {
      if (direction === 'in') fontSizeRef.current = Math.min(fontSizeRef.current + 2, MAX_FONT_SIZE);
      else if (direction === 'out') fontSizeRef.current = Math.max(fontSizeRef.current - 2, MIN_FONT_SIZE);
      else if (direction === 'reset') fontSizeRef.current = DEFAULT_FONT_SIZE;
      if (termRef.current) {
        termRef.current.options.fontSize = fontSizeRef.current;
        fitTerminal();
      }
    });

    // Right-click paste
    const container = containerRef.current;
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const text = window.agentPlex.clipboardReadText();
      if (text) {
        term.paste(text);
      }
    };
    container.addEventListener('contextmenu', handleContextMenu);

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    resizeObserver.observe(container);

    requestAnimationFrame(() => fitTerminal());

    return () => {
      container.removeEventListener('contextmenu', handleContextMenu);
      resizeObserver.disconnect();
      cleanupData();
      cleanupExit();
      cleanupZoom();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="session-terminal-view flex-1 min-w-0 h-full p-1 overflow-hidden bg-surface"
      ref={containerRef}
    />
  );
}

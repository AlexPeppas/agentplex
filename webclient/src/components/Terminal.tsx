import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore, termKey } from '../store';

// Identical palette to the desktop useTerminal TERMINAL_THEME.
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

interface Props {
  machineId: string;
  sessionId: string;
}

export default function Terminal({ machineId, sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);
  const generationRef = useRef(0);
  const sendCommand = useStore(s => s.sendCommand);

  const terminalData = useStore(s => s.terminalData[termKey(machineId, sessionId)] ?? '');
  const terminalGeneration = useStore(
    s => s.terminalGeneration[termKey(machineId, sessionId)] ?? 0,
  );

  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      theme: TERMINAL_THEME,
      fontFamily: "'MesloLGS Nerd Font Mono', Menlo, Monaco, 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(containerRef.current);

    xtermRef.current = xterm;
    fitRef.current = fit;
    writtenRef.current = 0;
    generationRef.current = terminalGeneration;

    // Fit once the terminal font is loaded so xterm's column count matches the
    // real glyph width (avoids output misalignment — same fix as the desktop).
    const doFit = () => { try { fit.fit(); } catch { /* ignore */ } };
    doFit();
    const fonts = document.fonts;
    if (fonts) {
      fonts.load('13px "MesloLGS Nerd Font Mono"').then(doFit).catch(() => undefined);
      fonts.ready.then(doFit).catch(() => undefined);
    }

    xterm.onData((data) => {
      sendCommand(machineId, { type: 'session:write', id: sessionId, data });
    });
    xterm.onResize(({ cols, rows }) => {
      sendCommand(machineId, { type: 'session:resize', id: sessionId, cols, rows });
    });

    const observer = new ResizeObserver(() => doFit());
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, sessionId]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    if (generationRef.current !== terminalGeneration) {
      xterm.reset();
      writtenRef.current = 0;
      generationRef.current = terminalGeneration;
    }
    const newData = terminalData.slice(writtenRef.current);
    if (newData.length === 0) return;
    xterm.write(newData);
    writtenRef.current = terminalData.length;
  }, [terminalData, terminalGeneration]);

  return (
    <div
      ref={containerRef}
      className="flex-1 w-full h-full overflow-hidden bg-surface"
      style={{ padding: '6px 8px' }}
    />
  );
}

import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore, termKey, subscribeTerminalOutput } from '../store';

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
  const sendCommand = useStore(s => s.sendCommand);
  const ready = useStore(s => Boolean(s.status[machineId]?.ready));
  const stopped = useStore(s => s.sessions.find(session => session.machineId === machineId && session.id === sessionId)?.status === 'killed');

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
      windowsPty: useStore.getState().sessions.find(session =>
        session.machineId === machineId && session.id === sessionId)?.windowsPty,
      disableStdin: !ready || stopped,
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(containerRef.current);

    xtermRef.current = xterm;
    fitRef.current = fit;
    // Capture replay and subscribe synchronously; live chunks bypass the bounded
    // cache and React batching, while explicit snapshots replace the terminal.
    const key = termKey(machineId, sessionId);
    const replay = useStore.getState().terminalData[key];
    if (replay) xterm.write(replay);
    const unsubscribeOutput = subscribeTerminalOutput(key, output => {
      if (output.type === 'buffer') xterm.reset();
      if (output.data) xterm.write(output.data);
    });

    // Fit once the terminal font is loaded so xterm's column count matches the
    // real glyph width (avoids output misalignment — same fix as the desktop).
    let disposed = false;
    const canSend = () => {
      const state = useStore.getState();
      return state.status[machineId]?.ready && state.sessions.some(session =>
        session.machineId === machineId && session.id === sessionId && session.status !== 'killed');
    };
    const doFit = () => {
      if (disposed || !containerRef.current?.clientWidth || !containerRef.current?.clientHeight) return;
      fit.fit();
    };
    const fonts = document.fonts;
    if (fonts) {
      fonts.load('13px "MesloLGS Nerd Font Mono"').then(doFit).catch(() => undefined);
      fonts.ready.then(doFit).catch(() => undefined);
    }

    xterm.onData((data) => {
      if (canSend()) sendCommand(machineId, { type: 'session:write', id: sessionId, data });
    });
    xterm.onResize(({ cols, rows }) => {
      if (canSend()) sendCommand(machineId, { type: 'session:resize', id: sessionId, cols, rows });
    });
    doFit();

    const observer = new ResizeObserver(() => doFit());
    observer.observe(containerRef.current);

    return () => {
      disposed = true;
      observer.disconnect();
      unsubscribeOutput();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, sessionId]);

  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;
    xterm.options.disableStdin = !ready || stopped;
    if (ready && !stopped) {
      fitRef.current?.fit();
      sendCommand(machineId, { type: 'session:resize', id: sessionId, cols: xterm.cols, rows: xterm.rows });
    }
  }, [ready, stopped, machineId, sessionId, sendCommand]);

  return (
    <div
      className="flex-1 min-h-0 min-w-0 w-full h-full overflow-hidden bg-surface"
      style={{ padding: '6px 8px' }}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  );
}

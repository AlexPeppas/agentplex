import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useStore, termKey } from '../store';

interface Props {
  machineId: string;
  sessionId: string;
}

export default function Terminal({ machineId, sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const writtenRef = useRef(0);    // how many chars from buffer we've already written
  const sendCommand = useStore(s => s.sendCommand);

  // Write new terminal data as it arrives (composite key per machine + session).
  const terminalData = useStore(s => s.terminalData[termKey(machineId, sessionId)] ?? '');

  // Mount terminal once per (machine, session).
  useEffect(() => {
    if (!containerRef.current) return;

    const xterm = new XTerm({
      theme: {
        background:  '#1a1814',
        foreground:  '#ece4d8',
        cursor:      '#ece4d8',
        black:       '#1a1814',
        brightBlack: '#4a4038',
        red:         '#e06c75',
        green:       '#98c379',
        yellow:      '#e5c07b',
        blue:        '#61afef',
        magenta:     '#c678dd',
        cyan:        '#56b6c2',
        white:       '#ece4d8',
        brightWhite: '#ffffff',
      },
      fontFamily: "'MesloLGS NF', 'Menlo', 'Courier New', monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(containerRef.current);
    fit.fit();

    xtermRef.current = xterm;
    fitRef.current = fit;
    writtenRef.current = 0;

    // Forward keystrokes to the owning machine.
    xterm.onData((data) => {
      sendCommand(machineId, { type: 'session:write', id: sessionId, data });
    });

    // Resize
    xterm.onResize(({ cols, rows }) => {
      sendCommand(machineId, { type: 'session:resize', id: sessionId, cols, rows });
    });

    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      xterm.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, sessionId]);

  // Stream new data into xterm as it arrives.
  useEffect(() => {
    const xterm = xtermRef.current;
    if (!xterm) return;

    const newData = terminalData.slice(writtenRef.current);
    if (newData.length === 0) return;

    xterm.write(newData);
    writtenRef.current = terminalData.length;
  }, [terminalData]);

  return (
    <div
      ref={containerRef}
      className="flex-1 w-full h-full overflow-hidden"
      style={{ padding: '6px 8px' }}
    />
  );
}

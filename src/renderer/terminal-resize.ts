import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

/** Drain output at the old geometry before resizing to the settled layout. */
export function createTerminalResizeController(
  term: Terminal,
  fit: FitAddon,
  container: HTMLElement,
  sendSize: (cols: number, rows: number) => void,
) {
  let disposed = false;
  let frame: number | null = null;
  let draining = false;
  let force = false;
  let lastCols = 0;
  let lastRows = 0;

  const apply = () => {
    draining = false;
    if (disposed) return;
    if (!container.isConnected || container.offsetParent === null ||
        container.clientWidth <= 0 || container.clientHeight <= 0) return;
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) ||
        dims.cols < 2 || dims.rows < 1) return;
    try {
      fit.fit();
      if (force || term.cols !== lastCols || term.rows !== lastRows) {
        sendSize(term.cols, term.rows);
        lastCols = term.cols;
        lastRows = term.rows;
      }
      if (force) term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
      force = false;
    } catch (error) {
      console.error('[terminal] Failed to synchronize terminal size', error);
    }
  };

  return {
    schedule(reassert = false) {
      if (disposed) return;
      force ||= reassert;
      if (frame !== null || draining) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = null;
          if (disposed) return;
          draining = true;
          term.write('', apply);
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

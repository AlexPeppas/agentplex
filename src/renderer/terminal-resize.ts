import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const RESIZE_SETTLE_MS = 100;
const MAX_RESIZE_RETRIES = 3;

/** Keep output at the old geometry until layout settles, then drain and resize. */
export function createTerminalResizeController(
  term: Terminal,
  fit: FitAddon,
  container: HTMLElement,
  sendSize: (cols: number, rows: number) => void,
) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frame: number | null = null;
  let draining = false;
  let revision = 0;
  let failures = 0;
  let force = false;
  let lastCols = 0;
  let lastRows = 0;

  const apply = (expectedRevision: number) => {
    draining = false;
    if (disposed || expectedRevision !== revision) return;
    if (!container.isConnected || container.offsetParent === null ||
        container.clientWidth <= 0 || container.clientHeight <= 0) return;
    try {
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) ||
          dims.cols < 2 || dims.rows < 1) return;
      fit.fit();
      if (force || term.cols !== lastCols || term.rows !== lastRows) {
        sendSize(term.cols, term.rows);
        lastCols = term.cols;
        lastRows = term.rows;
      }
      if (force) term.clearTextureAtlas();
      term.refresh(0, term.rows - 1);
      force = false;
      failures = 0;
    } catch (error) {
      console.error('[terminal] Failed to synchronize terminal size', error);
      force = true;
      if (++failures <= MAX_RESIZE_RETRIES) {
        timer = setTimeout(() => {
          timer = null;
          queueFrame(expectedRevision);
        }, RESIZE_SETTLE_MS);
      }
    }
  };

  const queueFrame = (expectedRevision: number) => {
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed || expectedRevision !== revision) return;
      if (draining) {
        queueFrame(expectedRevision);
        return;
      }
      draining = true;
      term.write('', () => apply(expectedRevision));
    });
  };

  return {
    schedule(reassert = false) {
      if (disposed) return;
      failures = 0;
      force ||= reassert;
      const expectedRevision = ++revision;
      if (timer !== null) clearTimeout(timer);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      // ConPTY redraws asynchronously after resize. Intermediate drag sizes can
      // otherwise leave an older redraw being parsed at the next geometry.
      timer = setTimeout(() => {
        timer = null;
        queueFrame(expectedRevision);
      }, RESIZE_SETTLE_MS);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}

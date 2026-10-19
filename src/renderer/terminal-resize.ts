import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

const RESIZE_SETTLE_MS = 100;
const MAX_RESIZE_RETRIES = 3;
/** Refit passes after a resize changed the measured cell (see `apply`). */
const MAX_REFIT_PASSES = 3;

/** xterm measures its character cell only on open, on font/DPR option changes
 *  and right after a resize. A web font that finishes loading later (the
 *  bundled Nerd Font) therefore leaves a stale cell size behind, and a fit
 *  computed from it over- or under-counts rows. A minimal, reversible fontSize
 *  change forces a fresh measurement without touching the buffer. */
function remeasureCells(term: Terminal) {
  const size = term.options.fontSize;
  if (typeof size !== 'number') return;
  term.options.fontSize = size + 0.001;
  term.options.fontSize = size;
}

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
      if (force) remeasureCells(term);
      const dims = fit.proposeDimensions();
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) ||
          dims.cols < 2 || dims.rows < 1) return;
      fit.fit();
      // xterm re-measures the cell right after a resize. When the measurement
      // changes (the first fit ran before the bundled web font was available),
      // the geometry just applied no longer fits the pane: refit until stable.
      for (let pass = 0; pass < MAX_REFIT_PASSES; pass++) {
        const again = fit.proposeDimensions();
        if (!again || !Number.isFinite(again.cols) || !Number.isFinite(again.rows) ||
            again.cols < 2 || again.rows < 1) break;
        if (again.cols === term.cols && again.rows === term.rows) break;
        fit.fit();
      }
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

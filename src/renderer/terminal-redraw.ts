/** Delay between the shrunken and the real PTY size. Node emits `resize` on
 *  stdout only when the window size it reads after SIGWINCH differs from the
 *  one it cached, so two ioctls landing before the CLI's event loop gets to the
 *  signal would collapse into "nothing changed" and no repaint. Give a busy CLI
 *  the same settle time the resize controller uses. */
export const REPLAY_REDRAW_DELAY_MS = 100;

/** Pick a size one cell smaller than the real one; `null` when the terminal is
 *  too small to shrink. Rows go first: a narrower terminal reflows every line,
 *  one row less is barely visible. */
function shrink(cols: number, rows: number): [number, number] | null {
  if (rows > 1) return [cols, rows - 1];
  if (cols > 2) return [cols - 1, rows];
  return null;
}

/** Wrap the PTY size sender of a pane that mounted over replayed history.
 *
 *  A full-screen CLI (Claude Code, Copilot) paints differentially against its
 *  own model of the screen, so replaying the retained buffer into a fresh xterm
 *  reconstructs a torn screen that stays torn until the CLI repaints everything.
 *  The CLI only does that on SIGWINCH, so the first size pushed after replay is
 *  preceded by a one-cell shrink: two distinct size changes, two SIGWINCHs, a
 *  full repaint at the real geometry. A real resize arriving in between wins
 *  over the pending restore so the PTY never ends up at a stale size. */
export function createReplayRedraw(
  sendSize: (cols: number, rows: number) => void,
  replayed: boolean,
) {
  let disposed = false;
  let pending = replayed;
  let restore: ReturnType<typeof setTimeout> | null = null;

  const cancelRestore = () => {
    if (restore === null) return;
    clearTimeout(restore);
    restore = null;
  };

  return {
    sendSize(cols: number, rows: number) {
      if (disposed) return;
      cancelRestore();
      const smaller = pending ? shrink(cols, rows) : null;
      pending = false;
      if (!smaller) {
        sendSize(cols, rows);
        return;
      }
      sendSize(smaller[0], smaller[1]);
      restore = setTimeout(() => {
        restore = null;
        sendSize(cols, rows);
      }, REPLAY_REDRAW_DELAY_MS);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRestore();
    },
  };
}

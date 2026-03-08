// Strips ANSI/VT100 escape sequences from raw pty data.
// Handles CSI (incl. private mode ?), OSC, character set, and Fe sequences.

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[[\d;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)?|\x1b[()][AB012]|\x1b[@-Z\\-_]|\x9b[\d;?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

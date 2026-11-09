import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { SessionInfo, TerminalSnapshot, TerminalLink } from '../shared/ipc-channels';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parse output at its original geometry, including while no pane is open. */
export class TerminalState {
  private terminal: Terminal;
  private serializer = new SerializeAddon();
  private disposed = false;
  private pending = new Set<(error: Error) => void>();
  private control = '';
  private controlMode: 'ground' | 'escape' | 'csi' | 'osc' | 'string' | 'string-escape' = 'ground';
  private outputRevision = 0;
  private resizeRevision = 0;
  private resizing = new Set<(applied: boolean, error?: unknown) => void>();

  constructor(cols: number, rows: number, windowsPty?: SessionInfo['windowsPty']) {
    this.terminal = new Terminal({ cols, rows, windowsPty, scrollback: 1000, allowProposedApi: true });
    this.terminal.loadAddon(this.serializer);
  }

  write(data: string): void {
    if (this.disposed) return;
    this.outputRevision++;
    this.trackControl(data);
    this.terminal.write(data);
  }

  size(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  resize(cols: number, rows: number, resized: (applied: boolean, error?: unknown) => void): void {
    if (this.disposed) { resized(false); return; }
    this.resizing.add(resized);
    const finish = (applied: boolean, error?: unknown) => {
      this.resizing.delete(resized);
      resized(applied, error);
    };
    const request = ++this.resizeRevision;
    const drain = () => {
      const revision = this.outputRevision;
      this.terminal.write('', () => {
        if (this.disposed) return;
        if (request !== this.resizeRevision) { finish(false); return; }
        if (revision !== this.outputRevision) { drain(); return; }
        try { this.terminal.resize(cols, rows); finish(true); }
        catch (error) { finish(false, error); }
      });
    };
    drain();
  }

  snapshot(offset: number): Promise<TerminalSnapshot> {
    const control = this.control + (this.controlMode === 'string-escape' ? '\x1b' : '');
    return this.read(() => ({
      buffer: this.serializer.serialize(), offset,
      cols: this.terminal.cols, rows: this.terminal.rows,
      pendingSequence: control || undefined,
    }));
  }

  private read<T>(capture: () => T): Promise<T> {
    if (this.disposed) return Promise.reject(new Error('Terminal state is closed'));
    return new Promise((resolve, reject) => {
      this.pending.add(reject);
      this.terminal.write('', () => {
        this.pending.delete(reject);
        if (this.disposed) return;
        try {
          resolve(capture());
        } catch (error) { reject(error); }
      });
    });
  }

  private trackControl(data: string): void {
    for (const character of data) {
      const code = character.charCodeAt(0);
      if (code === 0x18 || code === 0x1a || code === 0x9c) {
        this.controlMode = 'ground'; this.control = ''; continue;
      }
      if (code === 0x1b) {
        if (this.controlMode === 'osc' || this.controlMode === 'string') this.controlMode = 'string-escape';
        else { this.controlMode = 'escape'; this.control = character; }
        continue;
      }
      if (this.controlMode === 'string-escape') {
        if (character === '\\') { this.controlMode = 'ground'; this.control = ''; continue; }
        this.controlMode = 'escape'; this.control = '\x1b';
      }
      if (code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.controlMode = code === 0x9b ? 'csi' : code === 0x9d ? 'osc' : 'string';
        this.control = code === 0x9b ? character : code === 0x9d ? '\x1b]999;' : '\x1bP';
        continue;
      }
      if (this.controlMode === 'osc' || this.controlMode === 'string') {
        if (code === 7 && this.controlMode === 'osc') { this.controlMode = 'ground'; this.control = ''; }
        continue;
      }
      if (code < 0x20 || code === 0x7f || this.controlMode === 'ground') continue;
      if (this.controlMode === 'escape' && (character === ']' || 'P_X^'.includes(character))) {
        // Discard historical string commands until their terminator; notably,
        // completing an old OSC 52 must not overwrite the user's clipboard.
        this.controlMode = character === ']' ? 'osc' : 'string';
        this.control = character === ']' ? '\x1b]999;' : '\x1bP';
      } else if (this.controlMode === 'escape' && character === '[') {
        this.controlMode = 'csi'; this.control += character;
      } else if ((this.controlMode === 'csi' && code >= 0x40 && code <= 0x7e) ||
                 (this.controlMode === 'escape' && code >= 0x30 && code <= 0x7e)) {
        this.controlMode = 'ground'; this.control = '';
      } else {
        this.control += character;
        if (this.control.length > 4096) {
          console.error('[terminal] Incomplete control sequence exceeds 4096 characters');
          this.control = '\x1b[';
        }
      }
    }
  }

  links(line: number): Promise<TerminalLink[]> {
    if (this.disposed) return Promise.reject(new Error('Terminal state is closed'));
    return this.read(() => {
      const row = this.terminal.buffer.active.getLine(line - 1);
      if (!row) return [];
      const links: TerminalLink[] = [];
      let previousId = 0;
      for (let column = 0; column < row.length; column++) {
        const cell = row.getCell(column);
        const extended = cell && 'extended' in cell ? cell.extended : undefined;
        const id = isRecord(extended) && typeof extended.urlId === 'number' ? extended.urlId : 0;
        if (id && id === previousId) links[links.length - 1].end = column + 1;
        else if (id) {
          // xterm's proposed cell API omits URLs; guard its v6 link service.
          const core = '_core' in this.terminal ? this.terminal._core : undefined;
          const service = isRecord(core) ? core._oscLinkService : undefined;
          if (!isRecord(service) || typeof service.getLinkData !== 'function') {
            throw new Error('Unsupported xterm hyperlink metadata API');
          }
          const metadata: unknown = Reflect.apply(service.getLinkData, service, [id]);
          if (isRecord(metadata) && typeof metadata.uri === 'string') {
            links.push({ start: column + 1, end: column + 1, text: '', uri: metadata.uri });
          } else throw new Error('Terminal hyperlink metadata is missing');
        }
        previousId = id;
      }
      for (const link of links) link.text = row.translateToString(false, link.start - 1, link.end);
      return links;
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resized of this.resizing) resized(false);
    this.resizing.clear();
    for (const reject of this.pending) reject(new Error('Terminal state is closed'));
    this.pending.clear();
    this.terminal.dispose();
  }
}

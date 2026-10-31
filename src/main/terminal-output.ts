interface PendingOutput {
  chunks: string[];
  length: number;
  offset: number;
}

export class TerminalOutputBatcher {
  private pending = new Map<string, PendingOutput>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private publish: (id: string, data: string, offset: number) => void) {}

  push(id: string, data: string, offset: number): void {
    const pending = this.pending.get(id) ?? { chunks: [], length: 0, offset };
    pending.chunks.push(data);
    pending.length += data.length;
    pending.offset = offset;
    this.pending.set(id, pending);
    if (pending.length >= 64 * 1024) this.flush(id);
    if (this.pending.size && this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushAll();
      }, 8);
    }
  }

  flush(id: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (!this.pending.size && this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.publish(id, pending.chunks.join(''), pending.offset);
  }

  flushAll(): void {
    for (const id of this.pending.keys()) this.flush(id);
  }
}

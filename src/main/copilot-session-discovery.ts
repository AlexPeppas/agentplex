import * as fs from 'fs';
import * as path from 'path';
import { readWorkspaceCwd } from './copilot-session-scanner';
import { readHistoryLines } from './history-reader';

export class CopilotSessionDiscovery {
  private timer: ReturnType<typeof setInterval> | null = null;
  private controller: AbortController | null = null;
  private seen = new Set<string>();
  private busy = false;
  private baseline = true;
  private startedAt = 0;
  private activity = new Set<string>();
  private watcher: fs.FSWatcher | null = null;

  constructor(
    private root: string,
    private isManaged: (uuid: string) => boolean,
    private discovered: (uuid: string, cwd: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.startedAt = Date.now();
    this.controller = new AbortController();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 1000);
  }

  stop(): void {
    this.controller?.abort();
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    if (this.busy || !this.controller || this.controller.signal.aborted) return;
    this.busy = true;
    const signal = this.controller.signal;
    try {
      if (!this.watcher) {
        try {
          this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const parts = filename.toString().split(/[\\/]/);
            if (parts.length === 2 && parts[1] === 'events.jsonl') this.activity.add(parts[0]);
          });
          this.watcher.on('error', error => {
            console.error('[discovery] Session watch failed:', error);
            this.watcher?.close();
            this.watcher = null;
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(this.root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries = [];
      }
      for (const entry of entries) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(entry.name)
          || (this.seen.has(entry.name) && !this.activity.has(entry.name))) continue;
        const dir = path.join(this.root, entry.name);
        if (this.isManaged(entry.name)) {
          this.seen.add(entry.name);
          this.activity.delete(entry.name);
          continue;
        }
        if (this.baseline && (await fs.promises.stat(dir)).birthtimeMs < this.startedAt) {
          this.seen.add(entry.name);
          continue;
        }
        const resuming = this.seen.has(entry.name);
        this.activity.delete(entry.name);
        let cwd = await readWorkspaceCwd(path.join(dir, 'workspace.yaml'), signal);
        let started = false;
        for await (const line of readHistoryLines(path.join(dir, 'events.jsonl'), 64 * 1024, resuming, signal)) {
          let record;
          try { record = JSON.parse(line); } catch { continue; }
          if (resuming ? record?.type !== 'session.resume' || Date.parse(record.timestamp) < this.startedAt
            || !Number.isFinite(Date.parse(record.timestamp)) : record?.type !== 'session.start') continue;
          started = true;
          if (typeof record.data?.context?.cwd === 'string') cwd = record.data.context.cwd;
          break;
        }
        if (!cwd || !started) continue;
        try {
          if (!(await fs.promises.stat(cwd)).isDirectory()) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        signal.throwIfAborted();
        if (!this.isManaged(entry.name)) this.discovered(entry.name, cwd);
        this.seen.add(entry.name);
      }
      this.baseline = false;
    } catch (error) {
      if (!signal.aborted) console.error('[discovery] Failed to scan new Copilot sessions:', error);
    } finally {
      this.busy = false;
    }
  }
}

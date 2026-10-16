import * as fs from 'fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK_BYTES = 64 * 1024;

/** Read a fixed snapshot in small asynchronous chunks; closing also covers early exit. */
export async function* readHistoryLines(
  filePath: string,
  maxBytes: number,
  tail = false,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const { size } = await handle.stat();
    let offset = tail ? Math.max(0, size - maxBytes) : 0;
    const end = Math.min(size, offset + maxBytes);
    const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, end - offset));
    const decoder = new StringDecoder('utf8');
    let skipPartial = false;
    if (offset > 0) {
      const previous = Buffer.alloc(1);
      await handle.read(previous, 0, 1, offset - 1);
      skipPartial = previous[0] !== 10;
    }
    let pending = '';
    while (offset < end) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
      signal?.throwIfAborted();
      if (!bytesRead) break;
      offset += bytesRead;
      let chunk = buffer.subarray(0, bytesRead);
      if (skipPartial) {
        const newline = chunk.indexOf(10);
        if (newline < 0) continue;
        chunk = chunk.subarray(newline + 1);
        skipPartial = false;
      }
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        signal?.throwIfAborted();
        yield line;
      }
    }
    signal?.throwIfAborted();
    pending += decoder.end();
    if (pending) yield pending;
  } finally {
    await handle.close();
  }
}

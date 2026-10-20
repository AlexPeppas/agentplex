import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import type { OfficePreview } from '../shared/artifact-formats';

let active = 0;

export async function readOfficePreview(bytes: Buffer, extension: string): Promise<OfficePreview> {
  if (active >= 2) throw new Error('Two Office previews are already loading. Retry when one finishes.');
  active++;
  let worker: Worker | undefined;
  try {
    return await new Promise<OfficePreview>((resolve, reject) => {
      worker = new Worker(path.join(__dirname, 'office-preview-worker.js'), {
        workerData: { bytes, extension }, resourceLimits: { maxOldGenerationSizeMb: 192 },
      });
      let settled = false;
      const finish = (error?: Error, value?: OfficePreview) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else if (value) resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error('Office preview exceeded the 15 second processing limit'));
      }, 15000);
      worker.once('message', (message: { value?: OfficePreview; error?: string }) => {
        finish(message.error ? new Error(message.error) : message.value ? undefined : new Error('Office preview returned no content'), message.value);
      });
      worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', code => finish(new Error(`Office preview worker exited before returning content (code ${code})`)));
    });
  } finally {
    try { await worker?.terminate(); }
    finally { active--; }
  }
}

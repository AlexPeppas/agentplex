import { parentPort, workerData } from 'node:worker_threads';
import { parseOfficePreview } from './office-preview-parser';

const port = parentPort;
if (!port) throw new Error('Office preview must run in a worker');
parseOfficePreview(Buffer.from(workerData.bytes), workerData.extension)
  .then(value => port.postMessage({ value }))
  .catch(error => port.postMessage({ error: error instanceof Error ? error.message : String(error) }));

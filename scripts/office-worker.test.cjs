const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { loadSource } = require('./test-support.cjs');

test('Office workers report parser failures, unexpected exits and enforce concurrency without blocking future previews', async () => {
  const workers = [];
  class Worker extends EventEmitter {
    constructor(filename, options) {
      super();
      workers.push(this);
      assert.ok(filename.endsWith('office-preview-worker.js'));
      assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 192);
      assert.equal(options.workerData.bytes.buffer.byteLength, options.workerData.bytes.byteLength);
      assert.deepEqual(options.transferList, [options.workerData.bytes.buffer]);
      assert.equal(options.workerData.bytes.byteOffset, 0);
    }
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  const { readOfficePreview } = loadSource('src/main/office-preview.ts', { 'node:worker_threads': { Worker } });
  const first = readOfficePreview(Buffer.from('first'), '.docx');
  const second = readOfficePreview(Buffer.from('second'), '.doc');
  await assert.rejects(readOfficePreview(Buffer.from('third'), '.xlsx'), /already loading/);
  workers[0].emit('message', { error: 'Malformed document' });
  await assert.rejects(first, /Malformed document/);
  assert.equal(workers[0].terminated, true);
  workers[1].emit('exit', 1);
  await assert.rejects(second, /exited before/);
  const third = readOfficePreview(Buffer.from('third'), '.xlsx');
  const value = { kind: 'workbook', sheets: [], truncated: false };
  workers[2].emit('message', { value });
  assert.deepEqual(await third, value);
  workers[2].emit('exit', 0);
});

test('Office preview timeouts terminate the parser and release the concurrency slot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const workers = [];
  class Worker extends EventEmitter {
    constructor() { super(); workers.push(this); }
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  const { readOfficePreview } = loadSource('src/main/office-preview.ts', { 'node:worker_threads': { Worker } });
  const pending = assert.rejects(readOfficePreview(Buffer.from('input'), '.docx'), /15 second/);
  t.mock.timers.tick(15000);
  await pending;
  assert.equal(workers[0].terminated, true);
  const next = readOfficePreview(Buffer.from('input'), '.docx');
  workers[1].emit('message', { value: { kind: 'document', content: 'Recovered', format: 'text', warnings: [] } });
  assert.equal((await next).content, 'Recovered');
});

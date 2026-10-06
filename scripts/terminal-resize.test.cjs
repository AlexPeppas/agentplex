const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { createTerminalResizeController } = loadSource('src/renderer/terminal-resize.ts');

function fixture(t) {
  const frames = new Map();
  const writes = [];
  const calls = [];
  let next = 0;
  const oldRequest = global.requestAnimationFrame;
  const oldCancel = global.cancelAnimationFrame;
  global.requestAnimationFrame = cb => { frames.set(++next, cb); return next; };
  global.cancelAnimationFrame = id => frames.delete(id);
  t.after(() => { global.requestAnimationFrame = oldRequest; global.cancelAnimationFrame = oldCancel; });
  const container = { isConnected: true, offsetParent: {}, clientWidth: 800, clientHeight: 400 };
  const term = {
    cols: 80, rows: 24,
    write: (data, callback) => { assert.equal(data, ''); writes.push(callback); },
    clearTextureAtlas: () => calls.push('atlas'),
    refresh: (start, end) => calls.push(['refresh', start, end]),
  };
  const fit = {
    dims: { cols: 90, rows: 25 },
    proposeDimensions() { return this.dims; },
    fit() { calls.push('fit'); Object.assign(term, this.dims); },
  };
  const controller = createTerminalResizeController(term, fit, container,
    (cols, rows) => calls.push(['resize', cols, rows]));
  t.after(() => controller.dispose());
  const frame = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(cb => cb());
  };
  const drain = () => { while (writes.length) writes.shift()(); };
  const settle = () => { frame(); frame(); drain(); };
  return { container, term, fit, controller, calls, frames, writes, frame, drain, settle };
}

test('fullscreen bursts settle once, drain old output before resize and repaint on exit', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.controller.schedule();
  f.frame();
  f.fit.dims = { cols: 160, rows: 40 };
  f.frame();
  assert.deepEqual(f.calls, []);
  assert.equal(f.writes.length, 1);
  f.controller.schedule();
  f.drain();
  assert.deepEqual(f.calls, ['fit', ['resize', 160, 40], ['refresh', 0, 39]]);
  f.calls.length = 0;
  f.fit.dims = { cols: 90, rows: 25 };
  f.controller.schedule();
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 90, 25], ['refresh', 0, 24]]);
  f.calls.length = 0;
  f.controller.schedule();
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['refresh', 0, 24]]);
});

test('hidden or invalid geometry never reaches the PTY, and reveal recovers', t => {
  const f = fixture(t);
  f.container.clientHeight = 0;
  f.controller.schedule();
  f.settle();
  assert.deepEqual(f.calls, []);
  f.container.clientHeight = 400;
  f.fit.dims = { cols: NaN, rows: 25 };
  f.controller.schedule();
  f.settle();
  assert.deepEqual(f.calls, []);
  f.fit.dims = { cols: 90, rows: 25 };
  f.controller.schedule();
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 90, 25], ['refresh', 0, 24]]);
});

test('wake reasserts geometry and clears atlas; disposal cancels frames and queued writes', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.settle();
  f.calls.length = 0;
  f.controller.schedule(true);
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 90, 25], 'atlas', ['refresh', 0, 24]]);
  f.calls.length = 0;
  f.controller.schedule();
  f.frame();
  f.frame();
  f.controller.dispose();
  f.drain();
  assert.deepEqual(f.calls, []);
  f.controller.schedule(true);
  assert.equal(f.frames.size, 0);
});

test('closing before layout settles cancels the scheduled resize', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.frame();
  f.controller.dispose();
  assert.equal(f.frames.size, 0);
  f.settle();
  assert.deepEqual(f.calls, []);
});

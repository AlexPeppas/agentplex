const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { createTerminalResizeController } = loadSource('src/renderer/terminal-resize.ts');

function fixture(t) {
  const frames = new Map();
  const timers = new Map();
  const writes = [];
  const calls = [];
  let next = 0;
  const oldRequest = global.requestAnimationFrame;
  const oldCancel = global.cancelAnimationFrame;
  const oldTimeout = global.setTimeout;
  const oldClearTimeout = global.clearTimeout;
  global.requestAnimationFrame = cb => { frames.set(++next, cb); return next; };
  global.cancelAnimationFrame = id => frames.delete(id);
  global.setTimeout = cb => { timers.set(++next, cb); return next; };
  global.clearTimeout = id => timers.delete(id);
  t.after(() => {
    global.requestAnimationFrame = oldRequest;
    global.cancelAnimationFrame = oldCancel;
    global.setTimeout = oldTimeout;
    global.clearTimeout = oldClearTimeout;
  });
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
  const quiet = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach(cb => cb());
  };
  const settle = () => { quiet(); frame(); drain(); };
  return { container, term, fit, controller, calls, frames, timers, writes, frame, quiet, drain, settle };
}

test('fullscreen bursts settle once, drain old output before resize and repaint on exit', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.controller.schedule();
  f.quiet();
  f.fit.dims = { cols: 160, rows: 40 };
  f.frame();
  assert.deepEqual(f.calls, []);
  assert.equal(f.writes.length, 1);
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
  f.quiet();
  f.frame();
  f.controller.dispose();
  f.drain();
  assert.deepEqual(f.calls, []);
  f.controller.schedule(true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
});

test('closing before layout settles cancels the scheduled resize', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.quiet();
  f.frame();
  f.controller.dispose();
  assert.equal(f.frames.size, 0);
  f.settle();
  assert.deepEqual(f.calls, []);
});

test('continuous dragging does not send intermediate geometry to the PTY', t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    f.fit.dims = { cols: 80 + i, rows: 24 + i };
    f.controller.schedule();
    f.frame();
    f.frame();
    f.drain();
    assert.deepEqual(f.calls, []);
    assert.equal(f.timers.size, 1);
  }
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 109, 53], ['refresh', 0, 52]]);
});

test('layout changes while output drains invalidate the resize until settled again', t => {
  const f = fixture(t);
  f.controller.schedule(true);
  f.quiet();
  f.frame();
  assert.equal(f.writes.length, 1);
  f.fit.dims = { cols: 120, rows: 35 };
  f.controller.schedule();
  f.drain();
  assert.deepEqual(f.calls, [], 'stale drain must not resize at an unsettled geometry');
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 120, 35], 'atlas', ['refresh', 0, 34]]);
});

test('a settled resize waits for an older drain without losing the new request', t => {
  const f = fixture(t);
  f.controller.schedule();
  f.quiet();
  f.frame();
  f.controller.schedule();
  f.quiet();
  f.frame();
  assert.equal(f.writes.length, 1);
  f.drain();
  assert.deepEqual(f.calls, []);
  f.frame();
  f.drain();
  assert.deepEqual(f.calls, ['fit', ['resize', 90, 25], ['refresh', 0, 24]]);
});

test('transient measurement failure is reported and recovers without another layout event', t => {
  const f = fixture(t);
  const errors = [];
  const oldError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = oldError; });
  const measure = f.fit.proposeDimensions.bind(f.fit);
  let fail = true;
  f.fit.proposeDimensions = () => {
    if (fail) { fail = false; throw new Error('temporary measurement failure'); }
    return measure();
  };
  f.controller.schedule();
  f.settle();
  assert.equal(errors.length, 1);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.calls, []);
  f.settle();
  assert.deepEqual(f.calls, ['fit', ['resize', 90, 25], 'atlas', ['refresh', 0, 24]]);
  assert.equal(f.timers.size, 0);
});

test('persistent failures have bounded retries, cancelled on disposal', t => {
  const f = fixture(t);
  const errors = [];
  const oldError = console.error;
  console.error = (...args) => errors.push(args);
  t.after(() => { console.error = oldError; });
  f.fit.proposeDimensions = () => { throw new Error('measurement unavailable'); };
  f.controller.schedule();
  for (let i = 0; i < 4; i++) f.settle();
  assert.equal(errors.length, 4);
  assert.equal(f.timers.size, 0);
  f.controller.schedule();
  f.settle();
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { createReplayRedraw, REPLAY_REDRAW_DELAY_MS } = loadSource('src/renderer/terminal-redraw.ts');

function fixture(t, replayed) {
  const timers = new Map();
  const sent = [];
  let next = 0;
  const oldTimeout = global.setTimeout;
  const oldClearTimeout = global.clearTimeout;
  global.setTimeout = (cb, ms) => { timers.set(++next, { cb, ms }); return next; };
  global.clearTimeout = id => timers.delete(id);
  t.after(() => {
    global.setTimeout = oldTimeout;
    global.clearTimeout = oldClearTimeout;
  });
  const redraw = createReplayRedraw((cols, rows) => sent.push([cols, rows]), replayed);
  t.after(() => redraw.dispose());
  const elapse = () => {
    const pending = [...timers.values()];
    timers.clear();
    pending.forEach(entry => entry.cb());
  };
  return { redraw, sent, timers, elapse };
}

test('a pane mounted over replayed history shrinks one row, then restores the real size later', t => {
  const f = fixture(t, true);
  f.redraw.sendSize(90, 25);
  assert.deepEqual(f.sent, [[90, 24]], 'the shrunken size goes out at once');
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, REPLAY_REDRAW_DELAY_MS);
  f.elapse();
  assert.deepEqual(f.sent, [[90, 24], [90, 25]]);
  assert.equal(f.timers.size, 0);
});

test('a fresh pane without history sends its size once', t => {
  const f = fixture(t, false);
  f.redraw.sendSize(90, 25);
  assert.deepEqual(f.sent, [[90, 25]]);
  assert.equal(f.timers.size, 0);
});

test('only the first size after replay is doubled; later resizes pass straight through', t => {
  const f = fixture(t, true);
  f.redraw.sendSize(90, 25);
  f.elapse();
  f.sent.length = 0;
  f.redraw.sendSize(120, 35);
  f.redraw.sendSize(120, 35);
  assert.deepEqual(f.sent, [[120, 35], [120, 35]]);
  assert.equal(f.timers.size, 0);
});

test('a real resize during the redraw window replaces the pending restore', t => {
  const f = fixture(t, true);
  f.redraw.sendSize(90, 25);
  f.redraw.sendSize(120, 35);
  assert.deepEqual(f.sent, [[90, 24], [120, 35]]);
  assert.equal(f.timers.size, 0, 'the stale restore must not overwrite the new geometry');
  f.elapse();
  assert.deepEqual(f.sent, [[90, 24], [120, 35]]);
});

test('disposal cancels the pending restore', t => {
  const f = fixture(t, true);
  f.redraw.sendSize(90, 25);
  f.redraw.dispose();
  assert.equal(f.timers.size, 0);
  f.elapse();
  assert.deepEqual(f.sent, [[90, 24]]);
  f.redraw.sendSize(90, 25);
  assert.deepEqual(f.sent, [[90, 24]], 'a disposed wrapper sends nothing');
});

test('a single-row terminal shrinks a column instead, and a tiny one skips the redraw', t => {
  const f = fixture(t, true);
  f.redraw.sendSize(40, 1);
  f.elapse();
  assert.deepEqual(f.sent, [[39, 1], [40, 1]]);
  const g = fixture(t, true);
  g.redraw.sendSize(2, 1);
  assert.deepEqual(g.sent, [[2, 1]]);
  assert.equal(g.timers.size, 0);
});

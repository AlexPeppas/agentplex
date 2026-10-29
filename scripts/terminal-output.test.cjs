const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { TerminalOutputBatcher } = loadSource('src/main/terminal-output.ts');

test('fragmented ANSI, Unicode and session offsets survive coalescing without cross-session mixing', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const batcher = new TerminalOutputBatcher((id, data, offset) => events.push({ id, data, offset }));
  const fragments = ['\x1b[3', '2m', '\ud83d', '\ude00', '\x1b[0m\r\n'];
  let offset = 100;
  for (const fragment of fragments) {
    offset += fragment.length;
    batcher.push('a', fragment, offset);
  }
  batcher.push('b', 'independent', 200);
  assert.deepEqual(events, []);
  t.mock.timers.tick(8);
  assert.deepEqual(events, [
    { id: 'a', data: fragments.join(''), offset },
    { id: 'b', data: 'independent', offset: 200 },
  ]);
});

test('large bursts flush at the size bound without delaying another session or leaving duplicate timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const events = [];
  const batcher = new TerminalOutputBatcher((id, data, offset) => events.push({ id, data, offset }));
  batcher.push('other', 'waiting', 7);
  for (let index = 0; index < 64; index++) batcher.push('large', 'x'.repeat(1024), (index + 1) * 1024);
  assert.deepEqual(events, [{ id: 'large', data: 'x'.repeat(64 * 1024), offset: 64 * 1024 }]);
  t.mock.timers.tick(8);
  assert.deepEqual(events[1], { id: 'other', data: 'waiting', offset: 7 });
  batcher.push('large', 'final', 64 * 1024 + 5);
  batcher.flushAll();
  t.mock.timers.tick(100);
  assert.equal(events.length, 3);
  assert.equal(events[2].data, 'final');
});

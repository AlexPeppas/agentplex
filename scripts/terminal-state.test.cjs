const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Terminal } = require('@xterm/headless');
const { loadSource } = require('./test-support.cjs');
const { TerminalState } = loadSource('src/main/terminal-state.ts');
const windowsPty = { backend: 'conpty', buildNumber: 26100 };
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const screen = terminal => Array.from({ length: terminal.rows }, (_, index) =>
  terminal.buffer.active.getLine(terminal.buffer.active.baseY + index)?.translateToString(true));
async function restore(snapshot) {
  const terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, windowsPty, allowProposedApi: true });
  await write(terminal, snapshot.buffer + '\x18' + (snapshot.pendingSequence ?? ''));
  return terminal;
}

test('snapshots preserve resized screens rather than reinterpreting earlier output at a new width', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  const reference = new Terminal({ cols: 40, rows: 8, windowsPty, allowProposedApi: true });
  t.after(() => { state.dispose(); reference.dispose(); });
  const text = 'Table row | '.repeat(12) + '\r\nFooter\r\n';
  state.write(text);
  await write(reference, text);
  await new Promise(resolve => state.resize(22, 12, resolve));
  reference.resize(22, 12);
  state.write('live update');
  await write(reference, 'live update');
  const restored = await restore(await state.snapshot(text.length + 11));
  t.after(() => restored.dispose());
  assert.deepEqual(screen(restored), screen(reference));
  restored.resize(55, 9);
  reference.resize(55, 9);
  assert.deepEqual(screen(restored), screen(reference));
});

test('snapshot offsets cut the stream at the requested barrier without duplicating later output', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  t.after(() => state.dispose());
  state.write('before');
  const snapshot = state.snapshot(6);
  state.write('after');
  const restored = await restore(await snapshot);
  t.after(() => restored.dispose());
  assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'before');
  await write(restored, 'after');
  assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'beforeafter');
});

test('fragmented cursor and style sequences resume without repeating already executed controls', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  t.after(() => state.dispose());
  state.write('first\x1b[\n2;');
  const restored = await restore(await state.snapshot(11));
  t.after(() => restored.dispose());
  await write(restored, '3H\x1b[31mred');
  assert.equal(restored.buffer.active.getLine(1).translateToString(true), '  red');
  assert.equal(restored.buffer.active.getLine(1).getCell(2).getFgColor(), 1);
});

test('an incomplete historical clipboard command is discarded without exposing its payload or blocking new copies', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  t.after(() => state.dispose());
  state.write('safe\x1b]52;c;OLD');
  const restored = new Terminal({ cols: 40, rows: 8, windowsPty, allowProposedApi: true });
  t.after(() => restored.dispose());
  const copies = [];
  restored.parser.registerOscHandler(52, value => { copies.push(value); return true; });
  const snapshot = await state.snapshot(15);
  await write(restored, snapshot.buffer + '\x18' + snapshot.pendingSequence);
  await write(restored, 'PAYLOAD\x07\x1b]52;c;NEW\x07');
  assert.deepEqual(copies, ['c;NEW']);
  assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'safe');
});

test('OSC 8 metadata remains available for arbitrary labels after snapshotting and overwrites', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  t.after(() => state.dispose());
  state.write('\x1b]8;;file:///fixture/result.json\x07Open result\x1b]8;;\x07');
  const snapshot = await state.snapshot(1);
  assert.ok(snapshot.buffer.includes('Open result'));
  assert.deepEqual(await state.links(1), [{
    start: 1, end: 11, text: 'Open result', uri: 'file:///fixture/result.json',
  }]);
  state.write('\r\x1b[KPlain text');
  assert.deepEqual(await state.links(1), []);
});

test('a historical string terminator split after ESC does not swallow subsequent live output', async t => {
  for (const introducer of ['\x1b]52;c;', '\x1bP']) {
    const state = new TerminalState(40, 8, windowsPty);
    t.after(() => state.dispose());
    const data = 'safe' + introducer + 'OLD\x1b';
    state.write(data);
    const restored = await restore(await state.snapshot(data.length));
    t.after(() => restored.dispose());
    await write(restored, '\\visible');
    assert.equal(restored.buffer.active.getLine(0).translateToString(true), 'safevisible');
  }
});

test('retained terminal history stays bounded and pending snapshots reject when their session closes', async t => {
  const state = new TerminalState(40, 8, windowsPty);
  t.after(() => state.dispose());
  state.write('line\r\n'.repeat(3000));
  const restored = await restore(await state.snapshot(18000));
  t.after(() => restored.dispose());
  assert.ok(restored.buffer.active.length <= 1008);
  const pending = state.snapshot(18000);
  state.dispose();
  await assert.rejects(pending, /closed/);
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const cap = 512 * 1024;

async function fixture(t, initial) {
  let receive;
  const { useStore, termKey, subscribeTerminalOutput } = loadSource('webclient/src/store.ts', {
    './relay/client': { RelayClient: class {
      constructor(_machine, callbacks) { receive = callbacks.onEvent; }
      async start() {} stop() {} async send() {}
    } },
  });
  useStore.setState({ machines: [{ machineId: 'machine' }] });
  await useStore.getState().initRelay();
  const key = termKey('machine', 'session');
  receive({ type: 'session:buffer', id: 'session', buffer: initial });
  const previous = { document: global.document, ResizeObserver: global.ResizeObserver };
  global.document = {};
  global.ResizeObserver = class { observe() {} disconnect() {} };
  const writes = [], effects = [];
  let resets = 0, refs = 0;
  class XTerm {
    constructor(options) { this.options = options; }
    loadAddon() {} open() {} onData() {} onResize() {} dispose() {}
    reset() { resets++; }
    write(data) { writes.push(data); }
  }
  const store = Object.assign(selector => selector(useStore.getState()), { getState: useStore.getState });
  const { default: Terminal } = loadSource('webclient/src/components/Terminal.tsx', {
    '../store': { useStore: store, termKey, subscribeTerminalOutput },
    '@xterm/xterm': { Terminal: XTerm }, '@xterm/addon-fit': { FitAddon: class { fit() {} } },
    '@xterm/xterm/css/xterm.css': {},
    react: {
      useRef: value => ({ current: refs++ === 0 ? { clientWidth: 800, clientHeight: 400 } : value }),
      useEffect: callback => effects.push(callback),
    },
  });
  Terminal({ machineId: 'machine', sessionId: 'session' });
  const cleanups = effects.map(effect => effect());
  t.after(() => {
    cleanups.forEach(cleanup => cleanup?.());
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete global[name]; else global[name] = value;
    }
  });
  return {
    store: useStore, key, writes, resets: () => resets,
    clear() { writes.length = 0; resets = 0; },
    data(data) { receive({ type: 'session:data', id: 'session', data }); },
    snapshot(buffer) { receive({ type: 'session:buffer', id: 'session', buffer }); },
    unmount() { cleanups.forEach(cleanup => cleanup?.()); },
    listen: listener => subscribeTerminalOutput(key, listener),
  };
}

for (const size of [8, cap - 1024, cap]) {
  test(`mounted terminal consumes sustained overflow incrementally from an initial ${size}-character cache`, async t => {
    const f = await fixture(t, 'h'.repeat(size));
    assert.equal(f.writes[0].length, size);
    f.clear();
    for (let i = 0; i < 16; i++) f.data(String(i % 10).repeat(1024));
    assert.equal(f.resets(), 0);
    assert.deepEqual(f.writes.map(data => data.length), Array(16).fill(1024));
    assert.equal(f.writes.reduce((total, data) => total + data.length, 0), 16 * 1024);
    assert.ok(f.store.getState().terminalData[f.key].length <= cap);
    f.data('LARGE'.repeat(cap));
    assert.equal(f.writes.at(-1), 'LARGE'.repeat(cap), 'even a chunk larger than the cache is consumed in full');
    assert.equal(f.resets(), 0);
    assert.equal(f.store.getState().terminalData[f.key].length, cap);
    assert.equal(f.store.getState().terminalGeneration[f.key], 1, 'eviction is not a snapshot replacement');
  });
}

test('explicit snapshots reset once, later live output appends and unmounted listeners are removed', async t => {
  const f = await fixture(t, 'OLD\n');
  f.clear();
  f.snapshot('NEW\n');
  f.data('LIVE\n');
  assert.equal(f.resets(), 1);
  assert.deepEqual(f.writes, ['NEW\n', 'LIVE\n']);
  f.unmount();
  f.data('AFTER_UNMOUNT\n');
  assert.deepEqual(f.writes, ['NEW\n', 'LIVE\n']);
  const delivered = [];
  const unsubscribe = f.listen(output => delivered.push(output.data));
  f.unmount();
  f.data('NEW_OWNER\n');
  assert.deepEqual(delivered, ['NEW_OWNER\n'], 'old cleanup must not remove a new subscription');
  unsubscribe();
});

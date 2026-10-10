const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

function fixture(t) {
  const { useAppStore, serializeGroups } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const effects = [], noop = () => {};
  let resolveList, resolveSnapshot, rejectSnapshot, receiveData;
  const info = { id: 'session', title: 'Synthetic', status: 'idle', cli: 'copilot', cwd: process.cwd(),
    startedAt: Date.now(), lastActivityAt: Date.now() };
  const api = {
    listSessions: () => new Promise(resolve => { resolveList = resolve; }),
    getDisplayNames: async () => ({}),
    getSessionBufferSnapshot: () => new Promise((resolve, reject) => { resolveSnapshot = resolve; rejectSnapshot = reject; }),
    groupsLoad: async () => ({ version: 1, groups: [] }), groupsSave: async () => {},
    onSessionData: callback => { receiveData = callback; return noop; },
  };
  for (const name of ['onSessionStatus', 'onSessionExit', 'onSessionInfoUpdate',
    'onSubagentSpawn', 'onSubagentComplete', 'onPlanEnter', 'onPlanExit', 'onTaskCreate',
    'onTaskUpdate', 'onTaskList', 'onAppWake']) api[name] = () => noop;
  const oldWindow = global.window;
  global.window = { agentPlex: api };
  const store = Object.assign(select => select(useAppStore.getState()), {
    getState: useAppStore.getState, setState: useAppStore.setState, subscribe: useAppStore.subscribe,
  });
  const overrides = {
    react: { __esModule: true, default: { Component: class {} }, useEffect: callback => effects.push(callback),
      useRef: current => ({ current }), useState: initial => [initial, noop], useCallback: callback => callback },
    './store': { useAppStore: store, serializeGroups }, '@xyflow/react': { ReactFlowProvider: 'Flow' },
    './hooks/useTerminal': { scheduleRefreshAllTerminals: noop }, './types': {},
  };
  for (const name of ['Toolbar', 'GraphCanvas', 'TerminalPanel',
    'SendDialog', 'ProjectLauncher', 'ActivityBar', 'SidePanel']) {
    overrides[`./components/${name}`] = { [name]: `Synthetic${name}` };
  }
  loadSource('src/renderer/App.tsx', overrides).App();
  const cleanups = effects.map(effect => effect());
  t.after(() => {
    cleanups.forEach(cleanup => cleanup?.());
    if (oldWindow === undefined) delete global.window;
    else global.window = oldWindow;
  });
  return {
    store: useAppStore, info,
    output: (data, offset) => receiveData({ id: info.id, data, offset }),
    list: async () => { resolveList([info]); await new Promise(resolve => setImmediate(resolve)); },
    snapshot: async (buffer, offset) => {
      resolveSnapshot({ buffer, offset }); await new Promise(resolve => setImmediate(resolve));
    },
    reject: async () => {
      rejectSnapshot(new Error('Unknown session: session')); await new Promise(resolve => setImmediate(resolve));
    },
  };
}

for (const timing of ['before-list', 'after-capture', 'quiet']) {
  test(`desktop reconnect reconciles ${timing} output exactly once before terminals can mount`, async t => {
    const f = fixture(t);
    assert.equal(f.store.getState().buffersReady, false);
    if (timing === 'before-list') f.output('LIVE\n', 13);
    await f.list();
    assert.equal(f.store.getState().buffersReady, false);
    if (timing === 'after-capture') f.output('LIVE\n', 13);
    await f.snapshot(timing === 'before-list' ? 'HISTORY\nLIVE\n' : 'HISTORY\n',
      timing === 'before-list' ? 13 : 8);
    assert.equal(f.store.getState().buffersReady, true);
    assert.equal(f.store.getState().sessionBuffers.session, timing === 'quiet' ? 'HISTORY\n' : 'HISTORY\nLIVE\n');
    const end = f.store.getState().sessionBufferOffsets.session;
    f.output('POST\n', end + 5);
    assert.ok(f.store.getState().sessionBuffers.session.endsWith('POST\n'));
  });
}

test('bounded replay rejects a stale snapshot that cannot cover evicted live output', t => {
  const f = fixture(t);
  f.output('x'.repeat(2 * 1024 * 1024 + 1), 2 * 1024 * 1024 + 1);
  assert.equal(f.store.getState().hydrateBuffer('session', { buffer: 'old', offset: 0 }), false);
  assert.equal(f.store.getState().buffersReady, false);
  assert.equal(f.store.getState().hydrateBuffer('session', { buffer: 'fresh', offset: 2 * 1024 * 1024 + 1 }), true);
  assert.equal(f.store.getState().sessionBuffers.session, 'fresh');
});

test('removing a session during snapshot hydration does not block the remaining terminal workspace', async t => {
  const f = fixture(t);
  await f.list();
  f.store.getState().removeSession('session');
  await f.reject();
  assert.equal(f.store.getState().buffersReady, true);
  assert.equal(f.store.getState().sessions.session, undefined);
});

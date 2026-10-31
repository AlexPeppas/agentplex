const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

test('incoming names never echo rename commands or duplicate existing nodes', () => {
  const { useAppStore } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const writes = [];
  const previousWindow = global.window;
  global.window = { agentPlex: { updateSessionState: (id, name) => writes.push({ id, name }) } };
  try {
    const info = { id: 'session-1', title: 'Session 1 - agentplex', status: 'idle', cli: 'copilot', cwd: process.cwd() };
    useAppStore.getState().addSession(info);
    useAppStore.getState().applySessionName(info.id, 'My project');
    assert.equal(writes.length, 0);
    useAppStore.getState().renameSession(info.id, 'New project');
    assert.deepEqual(writes, [{ id: info.id, name: 'New project' }]);

    for (const name of ['My project', info.title, 'New project', 'New project']) {
      useAppStore.getState().addSession(info);
      useAppStore.getState().applySessionName(info.id, name);
    }
    assert.equal(writes.length, 1, 'incoming names must not send rename commands');
    assert.equal(useAppStore.getState().displayNames[info.id], 'New project');
    assert.equal(useAppStore.getState().nodes[0].data.label, 'New project');
    assert.equal(useAppStore.getState().nodes.length, 1);
    const snapshot = useAppStore.getState();
    snapshot.applySessionName(info.id, 'New project');
    assert.equal(useAppStore.getState(), snapshot, 'same-name updates are no-ops');
    snapshot.applySessionName('removed-session', 'Stale name');
    assert.equal(useAppStore.getState().displayNames['removed-session'], undefined);
    snapshot.renameSession(info.id, 'New project');
    assert.equal(writes.length, 1);
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});

test('restore preserves custom names in saved state before renderer involvement', () => {
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    'node-pty': {}, electron: {}, './shell-detector': {}, './settings-manager': {},
    './claude-session-scanner': {}, './copilot-session-scanner': {},
    './plan-task-detector': {}, './config-loader': {},
  });
  const manager = new SessionManager();
  manager.loadState = () => ({ sessions: {
    old1: { cwd: process.cwd(), cli: 'copilot', resumeSessionId: 'resume-1', displayName: 'Copilot project' },
    old2: { cwd: process.cwd(), cli: 'claude', resumeSessionId: 'resume-2', displayName: 'Claude project' },
  } });
  manager.createWithUuid = (cwd, cli, resumeSessionId) => {
    const id = `session-${manager.sessions.size + 1}`;
    const session = { id, title: `${id} - agentplex`, displayName: `${id} - agentplex`, cwd, cli, resumeSessionId, pty: { pid: 1 } };
    manager.sessions.set(id, session);
    return manager.list().find(s => s.id === id);
  };
  const savedNames = [];
  manager.saveState = () => savedNames.push(manager.getDisplayNames());
  const restored = manager.restoreAll();
  const expected = { 'session-1': 'Copilot project', 'session-2': 'Claude project' };
  assert.deepEqual(savedNames, [expected]);
  assert.deepEqual(manager.getDisplayNames(), expected);
  assert.deepEqual(restored.map(session => session.displayName), Object.values(expected));
});

test('activity and usage updates preserve graph identities while metadata and status changes remain visible', () => {
  const { useAppStore: store } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const info = { id: 'one', title: 'One', cli: 'copilot', cwd: 'original', status: 'idle', lastActivityAt: 1 };
  store.getState().addSession(info);
  store.getState().addSession({ ...info, id: 'two' });
  const nodes = store.getState().nodes;
  for (let index = 0; index < 100; index++) {
    store.getState().updateSessionInfo('one', { lastActivityAt: index + 2, usage: { contextTokens: index } });
  }
  assert.equal(store.getState().nodes, nodes);
  assert.equal(store.getState().sessions.one.usage.contextTokens, 99);
  assert.equal(store.getState().sessions.one.lastActivityAt, 101);
  const snapshot = store.getState();
  snapshot.updateSessionInfo('one', { cwd: 'original' });
  snapshot.updateStatus('one', 'idle');
  assert.equal(store.getState(), snapshot, 'unchanged updates must not publish');
  snapshot.updateSessionInfo('one', { cwd: 'changed', cli: 'claude', status: 'running' });
  const changed = store.getState();
  assert.notEqual(changed.nodes, nodes);
  assert.equal(changed.nodes[1], nodes[1]);
  assert.equal(changed.nodes[0].data.cwd, 'changed');
  assert.equal(changed.nodes[0].data.cli, 'claude');
  assert.equal(changed.nodes[0].data.status, 'running');
  changed.updateStatus('one', 'waiting-for-input');
  assert.equal(store.getState().nodes[0].data.status, 'waiting-for-input');
});

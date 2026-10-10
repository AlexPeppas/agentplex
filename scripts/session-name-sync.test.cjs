const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

test('incoming names never echo rename commands, even with queued stale catalogs', () => {
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
    assert.equal(writes.length, 1, 'catalog updates must not produce further catalogs');
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

test('restore preserves custom names in the first catalog and saved state before renderer involvement', async () => {
  const { IPC } = loadSource('src/shared/ipc-channels.ts');
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
    manager.publishCatalog();
    return manager.list().find(s => s.id === id);
  };
  const savedNames = [];
  manager.saveState = () => savedNames.push(manager.getDisplayNames());
  const catalogs = [];
  manager.events.on(IPC.SESSION_CATALOG, catalog => catalogs.push(catalog));
  const restored = manager.restoreAll();
  await Promise.resolve();
  const expected = { 'session-1': 'Copilot project', 'session-2': 'Claude project' };
  assert.deepEqual(savedNames, [expected]);
  assert.equal(catalogs.length, 1);
  assert.deepEqual(catalogs[0].names, expected);
  assert.deepEqual(manager.getDisplayNames(), expected);
  assert.deepEqual(restored.map(session => session.displayName), Object.values(expected));
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    'node-pty': {}, electron: {}, './shell-detector': {}, './settings-manager': {},
    './claude-session-scanner': {}, './copilot-session-scanner': {}, './plan-task-detector': {}, './config-loader': {},
  });
  const manager = new SessionManager();
  const info = { id: 'session', title: 'Synthetic', status: 'idle', cli: 'copilot', cwd: process.cwd(),
    pty: { pid: 1 }, resumeSessionId: null };
  manager.sessions.set(info.id, info);
  manager.getDisplayNames = () => ({});
  const { RelayClient } = loadSource('src/main/remote/relay-client.ts', {
    '../session-manager': { sessionManager: manager }, './key-manager': { getMachineId: () => 'first' },
  });
  const relay = new RelayClient({ relayUrl: 'http://unused.invalid' });
  const responses = [], events = [];
  relay.sendEncryptedToDevice = (_id, data) => responses.push(data);
  relay.broadcastEncrypted = data => events.push(data);
  relay.subscribeToEvents();
  t.after(() => relay.unsubscribeFromEvents());
  const callbacks = {};
  class Transport {
    constructor(machine, handlers) { callbacks[machine.machineId] = handlers; }
    async start() {} stop() {} async send() {}
  }
  const { useStore } = loadSource('webclient/src/store.ts', { './relay/client': { RelayClient: Transport } });
  useStore.setState({ machines: [{ machineId: 'first' }, { machineId: 'second' }] });
  const key = 'first:session';
  return {
    manager, relay, responses, events, store: useStore, callbacks, key,
    emit: (channel, data) => manager.send(channel, { sessionId: 'session', ...data }),
    discover() { relay.dispatchRemoteCommand({ type: 'session:list' }, 'owned-device'); return responses.at(-1); },
  };
}

test('first connect and missed completions recover authoritative traces through the actual desktop dispatcher and bridge', async t => {
  const f = fixture(t);
  f.emit(IPC.PLAN_ENTER, { planTitle: 'Work' });
  f.emit(IPC.TASK_LIST, { tasks: [{ taskNumber: 1, description: 'Work', status: 'in_progress' }] });
  f.emit(IPC.SUBAGENT_SPAWN, { subagentId: 'agent', description: 'Inspect' });
  await f.store.getState().initRelay();
  const first = f.callbacks.first;
  first.onStatus('connected', true);
  first.onEvent(f.discover());
  assert.equal(f.store.getState().status.first.traceReady, true);
  assert.equal(f.store.getState().traces[f.key].mode, 'plan');
  assert.equal(f.store.getState().traces[f.key].subagents[0].status, 'active');
  first.onStatus('disconnected', false);
  assert.equal(f.store.getState().traces[f.key], undefined);
  f.emit(IPC.PLAN_EXIT, {});
  f.emit(IPC.TASK_UPDATE, { taskNumber: 1, status: 'completed' });
  f.emit(IPC.SUBAGENT_COMPLETE, { subagentId: 'agent' });
  first.onStatus('connected', true);
  first.onEvent(f.discover());
  assert.equal(f.store.getState().traces[f.key].mode, 'normal');
  assert.equal(f.store.getState().traces[f.key].tasks[0].status, 'completed');
  assert.deepEqual(f.store.getState().traces[f.key].subagents, []);
});

test('newer full live state wins over delayed snapshots and out-of-order events without losing task identities', async t => {
  const f = fixture(t);
  f.emit(IPC.TASK_LIST, { tasks: [{ taskNumber: 1, description: 'Work', status: 'pending' }] });
  const old = f.discover();
  await f.store.getState().initRelay();
  f.callbacks.first.onStatus('connected', true);
  f.emit(IPC.TASK_UPDATE, { taskNumber: 1, status: 'in_progress' });
  const middle = f.events.at(-1);
  f.emit(IPC.TASK_UPDATE, { taskNumber: 1, status: 'completed' });
  const latest = f.events.at(-1);
  f.callbacks.first.onEvent(latest);
  f.callbacks.first.onEvent(old);
  f.callbacks.first.onEvent(middle);
  f.callbacks.first.onEvent(latest);
  assert.equal(f.store.getState().traces[f.key].tasks[0].status, 'completed');
  assert.equal(f.store.getState().traces[f.key].tasks[0].description, 'Work');
  f.callbacks.second.onStatus('connected', true);
  f.callbacks.second.onEvent(old);
  assert.equal(f.store.getState().traces['second:session'].tasks[0].status, 'pending');
  f.callbacks.first.onStatus('disconnected', false);
  assert.equal(f.store.getState().traces['second:session'].tasks[0].status, 'pending');
});

test('an old completion fade cannot delete a newly hydrated active agent with the same ID', async t => {
  const f = fixture(t);
  await f.store.getState().initRelay();
  const first = f.callbacks.first;
  f.emit(IPC.SUBAGENT_SPAWN, { subagentId: 'agent', description: 'Old' });
  first.onEvent(f.events.at(-1));
  f.emit(IPC.SUBAGENT_COMPLETE, { subagentId: 'agent' });
  first.onEvent(f.events.at(-1));
  f.emit(IPC.SUBAGENT_SPAWN, { subagentId: 'agent', description: 'New' });
  first.onEvent(f.discover());
  t.mock.timers.tick(4000);
  assert.equal(f.store.getState().traces[f.key].subagents[0].description, 'New');
  assert.equal(f.store.getState().traces[f.key].subagents[0].status, 'active');
});

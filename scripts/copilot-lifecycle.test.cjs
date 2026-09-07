const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { CopilotLifecycle } = loadSource('src/main/copilot-lifecycle.ts');
const { JsonlSessionWatcher } = loadSource('src/main/jsonl-session-watcher.ts');
const { SessionManager } = loadSource('src/main/session-manager.ts', {
  'node-pty': {}, electron: {},
  './shell-detector': {}, './settings-manager': {},
  './claude-session-scanner': {}, './copilot-session-scanner': {},
  './plan-task-detector': {}, './config-loader': {},
});
const { IPC } = loadSource('src/shared/ipc-channels.ts');
const event = (type, data = {}) => ({ type, data });
const feed = (state, ...events) => events.forEach(e => state.accept(e));
const begin = id => event('assistant.turn_start', { turnId: id });
const end = id => event('assistant.turn_end', { turnId: id });
const tool = (id, toolName = 'powershell', turnId = 't1') => event('tool.execution_start', { toolCallId: id, toolName, turnId });
const done = id => event('tool.execution_complete', { toolCallId: id });
const request = (id, owner) => event('permission.requested', { requestId: id, permissionRequest: { toolCallId: owner } });
const approved = id => event('permission.completed', { requestId: id });

test('idle prompt -> thinking -> tools -> next turn -> idle uses assistant boundaries, not model telemetry', () => {
  const state = new CopilotLifecycle();
  assert.equal(state.status, 'idle');
  feed(state, event('user.message'), begin('t1'));
  assert.equal(state.status, 'running');
  feed(state, event('model.turn_ended'), event('model.messages_snapshot'));
  assert.equal(state.status, 'running');
  feed(state, tool('a'), tool('b'), done('a'));
  assert.equal(state.status, 'running');
  feed(state, done('b'), end('t1'), begin('t2'));
  assert.equal(state.status, 'running');
  feed(state, event('assistant.message', { turnId: 't2', content: 'Allow changes? >', toolRequests: [] }));
  assert.equal(state.status, 'running');
  feed(state, end('t2'), event('model.turn_started'), event('session.warning'));
  assert.equal(state.status, 'idle');
});

test('overlapping permissions resolve individually; tool completion recovers omitted resolution events', () => {
  const state = new CopilotLifecycle();
  feed(state, begin('t1'), tool('a'), tool('b'), request('p1', 'a'), request('p2', 'b'));
  assert.equal(state.status, 'waiting-for-input');
  feed(state, approved('unrelated'), approved('p1'));
  assert.equal(state.status, 'waiting-for-input');
  feed(state, done('b'));
  assert.equal(state.status, 'running');
  feed(state, done('a'), end('t1'), approved('p2'));
  assert.equal(state.status, 'idle');
});

test('ask_user is attention only while its tool call is unresolved', () => {
  const state = new CopilotLifecycle();
  feed(state, begin('t1'), tool('q', 'ask_user'), tool('a'));
  assert.equal(state.status, 'waiting-for-input');
  feed(state, event('user.message'), done('a'));
  assert.equal(state.status, 'waiting-for-input');
  feed(state, done('q'));
  assert.equal(state.status, 'running');
  feed(state, end('t1'));
  assert.equal(state.status, 'idle');
});

test('messages without turn IDs cannot leave an orphaned running turn', () => {
  const state = new CopilotLifecycle();
  feed(state, begin('t1'), event('assistant.message', { content: 'Finished' }), end('t1'));
  assert.equal(state.status, 'idle');
  feed(state, begin('t2'), event('assistant.turn_end'));
  assert.equal(state.status, 'idle');
});

test('completion, cancellation, query failure, resume and shutdown clear stale attention', () => {
  for (const terminal of [end('t1'), event('abort'), event('session.error', { errorType: 'query' }),
    event('session.resume'), event('session.shutdown'), event('session.idle')]) {
    const state = new CopilotLifecycle();
    feed(state, begin('t1'), tool('a'), request('p1', 'a'), tool('q', 'ask_user'), terminal);
    assert.equal(state.status, 'idle', terminal.type);
    feed(state, approved('p1'), done('q'), done('a'));
    assert.equal(state.status, 'idle', `late completion after ${terminal.type}`);
    feed(state, begin('t2'));
    assert.equal(state.status, 'running');
  }
});

function logFixture(t, records = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-lifecycle-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, records.map(e => JSON.stringify(e) + '\n').join(''));
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
  return {
    file,
    append: (...records) => fs.appendFileSync(file, records.map(e => JSON.stringify(e) + '\n').join('')),
  };
}

test('watcher publishes one final lifecycle per poll, including tool-round boundaries and partial appends', t => {
  const log = logFixture(t);
  const watcher = new JsonlSessionWatcher(log.file, 'copilot');
  const statuses = [];
  watcher.on('lifecycle', s => statuses.push(s));
  log.append(begin('t1'));
  watcher.poll();
  log.append(tool('a'), done('a'), end('t1'), begin('t2'));
  watcher.poll();
  assert.deepEqual(statuses, ['running']);
  fs.appendFileSync(log.file, '{"type":"permission.requested","data":{"requestId":');
  watcher.poll();
  assert.equal(watcher.lifecycleStatus, 'running');
  fs.appendFileSync(log.file, '"p"}}\n');
  watcher.poll();
  assert.equal(watcher.lifecycleStatus, 'waiting-for-input');
  log.append(approved('p'), end('t2'));
  watcher.poll();
  assert.deepEqual(statuses, ['running', 'waiting-for-input', 'idle']);
  fs.writeFileSync(log.file, '');
  watcher.poll();
  assert.equal(watcher.lifecycleStatus, 'idle');
});

test('attach hydrates current lifecycle without replaying old UI events; resume launch ignores old waits', async t => {
  const log = logFixture(t, [
    begin('old'), tool('old-tool'), request('old-permission', 'old-tool'),
    event('session.resume'), begin('new'), tool('new-tool'), request('new-permission', 'new-tool'),
    event('subagent.started', { toolCallId: 'agent', agentName: 'explore' }),
  ]);
  const attached = new JsonlSessionWatcher(log.file, 'copilot', true, true);
  const launched = new JsonlSessionWatcher(log.file, 'copilot', true);
  const uiEvents = [];
  attached.on('permission-requested', e => uiEvents.push(e));
  attached.on('agent-spawn', e => uiEvents.push(e));
  attached.start();
  launched.start();
  t.after(() => { attached.stop(); launched.stop(); });
  // This append must be consumed by poll, not read ahead by snapshot hydration.
  log.append(approved('new-permission'));
  await Promise.resolve();
  assert.equal(attached.lifecycleStatus, 'waiting-for-input');
  assert.equal(launched.lifecycleStatus, 'idle');
  assert.deepEqual(uiEvents, []);
  attached.poll();
  assert.equal(attached.lifecycleStatus, 'running');
  log.append(end('new'));
  attached.poll();
  assert.equal(attached.lifecycleStatus, 'idle');
});

test('a record split across startup snapshot and live tail is not lost', async t => {
  const log = logFixture(t);
  fs.appendFileSync(log.file, '{"type":"assistant.turn_start",');
  const watcher = new JsonlSessionWatcher(log.file, 'copilot', true, true);
  watcher.start();
  t.after(() => watcher.stop());
  await Promise.resolve();
  fs.appendFileSync(log.file, '"data":{"turnId":"live"}}\n');
  watcher.poll();
  assert.equal(watcher.lifecycleStatus, 'running');
});

test('manager ignores Copilot terminal keywords, buffer caps and log age, sends live status and never revives killed sessions', t => {
  const log = logFixture(t);
  const manager = new SessionManager();
  const messages = [];
  manager.send = (channel, data) => messages.push({ channel, data });
  const watcher = manager.createJsonlWatcher(log.file, 'session-1', 'copilot');
  const session = {
    id: 'session-1', cli: 'copilot', status: 'waiting-for-input',
    buffer: 'Do you want to allow this? Esc to cancel\n> ',
    waitingSince: 1, waitingBufferLen: 512 * 1024, lastVisibleOutput: 0,
    lastActivityAt: 0, jsonlWatcher: watcher,
  };
  manager.sessions.set(session.id, session);
  manager.checkStatuses();
  assert.equal(session.status, 'idle');
  log.append(begin('t1'), tool('long-running'));
  watcher.poll();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(log.file, old, old);
  manager.checkStatuses();
  assert.equal(session.status, 'running');
  log.append(request('p1', 'long-running'));
  watcher.poll();
  assert.equal(session.status, 'waiting-for-input');
  log.append(approved('p1'));
  watcher.poll();
  assert.equal(session.status, 'running');
  log.append(done('long-running'), end('t1'));
  watcher.poll();
  manager.checkStatuses();
  assert.equal(session.status, 'idle');
  assert.deepEqual(messages.filter(m => m.channel === IPC.SESSION_STATUS).map(m => m.data.status),
    ['idle', 'running', 'waiting-for-input', 'running', 'idle']);
  watcher.emit('telemetry', { contextTokens: 123, updatedAt: 100 });
  assert.equal(session.usage.contextTokens, 123);
  watcher.emit('agent-complete', { toolUseId: 'agent' });
  assert.equal(watcher.listenerCount('telemetry'), 1);
  session.status = 'killed';
  watcher.emit('lifecycle', 'running');
  manager.checkStatuses();
  assert.equal(session.status, 'killed');
});

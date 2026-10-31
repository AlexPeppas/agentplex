const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const uuid = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const record = (type, data) => JSON.stringify({ type, data }) + '\n';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-child-cli-'));
  const root = path.join(home, '.copilot', 'session-state');
  fs.mkdirSync(root, { recursive: true });
  const disposers = [];
  t.after(() => { for (const dispose of disposers) dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const overrides = {
    os: { ...os, homedir: () => home }, electron: {},
    './settings-manager': { getDefaultShellId: () => null },
    'node-pty': { spawn() { assert.fail('Monitoring must never spawn another CLI'); } },
  };
  const { CopilotSessionDiscovery } = loadSource('src/main/copilot-session-discovery.ts', overrides);
  const make = (n, data = record('session.start', { context: { cwd: home } })) => {
    const dir = path.join(root, uuid(n));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), data);
    return path.join(dir, 'events.jsonl');
  };
  return { home, root, overrides, CopilotSessionDiscovery, make, disposers };
}

test('discovery skips historical and managed sessions, retries incomplete new CLIs and stops cleanly', async t => {
  const f = fixture(t);
  f.make(1);
  const found = [];
  const discovery = new f.CopilotSessionDiscovery(f.root, id => id === uuid(2), (...args) => found.push(args));
  f.disposers.push(() => discovery.stop());
  // Drive the real asynchronous poll deterministically without a timer.
  discovery.controller = new AbortController();
  discovery.startedAt = Date.now() + 100;
  await discovery.poll();
  assert.deepEqual(found, []);
  f.make(2);
  const pending = f.make(3, '');
  await discovery.poll();
  assert.deepEqual(found, []);
  fs.appendFileSync(pending, record('session.start', { context: { cwd: f.home } }));
  await discovery.poll();
  await discovery.poll();
  assert.deepEqual(found, [[uuid(3), f.home]]);
  discovery.stop();
  f.make(4);
  await discovery.poll();
  assert.equal(found.length, 1);
});

test('existing directories are discovered only after a fresh provider resume, not background file activity', async t => {
  const f = fixture(t);
  const old = f.make(1);
  const found = [];
  const discovery = new f.CopilotSessionDiscovery(f.root, () => false, (...args) => found.push(args));
  f.disposers.push(() => discovery.stop());
  discovery.controller = new AbortController();
  discovery.startedAt = Date.now() + 50;
  await discovery.poll();
  discovery.startedAt = Date.now() - 1;
  fs.appendFileSync(old, record('assistant.message', { content: 'edited historical data' }));
  discovery.activity.add(uuid(1));
  await discovery.poll();
  assert.deepEqual(found, []);
  fs.appendFileSync(old, JSON.stringify({ type: 'session.resume', timestamp: new Date().toISOString(),
    data: { context: { cwd: f.home } } }) + '\n');
  discovery.activity.add(uuid(1));
  await discovery.poll();
  assert.deepEqual(found, [[uuid(1), f.home]]);
  discovery.ignore(uuid(1));
  fs.appendFileSync(old, record('assistant.message', { content: 'still active after detaching' }));
  discovery.activity.add(uuid(1));
  await discovery.poll();
  assert.equal(found.length, 1, 'past resumes cannot resurrect a detached monitor');
});

test('filesystem changes discover short-lived CLIs before the fallback poll', async t => {
  const f = fixture(t);
  const found = [];
  const discovery = new f.CopilotSessionDiscovery(f.root, () => false, id => found.push(id));
  f.disposers.push(() => discovery.stop());
  discovery.start();
  const waitUntil = async (predicate, timeout) => {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      assert.ok(performance.now() < deadline, 'discovery must react to the filesystem without waiting a second');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await waitUntil(() => !discovery.baseline, 500);
  const began = performance.now();
  const file = f.make(1, '');
  // Session metadata and the initial record need not be written atomically.
  await new Promise(resolve => setTimeout(resolve, 50));
  fs.appendFileSync(file, record('session.start', { context: { cwd: f.home } }));
  await waitUntil(() => found.length === 1, 650);
  assert.ok(performance.now() - began < 750);
  assert.deepEqual(found, [uuid(1)]);
  discovery.stop();
  f.make(2);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.deepEqual(found, [uuid(1)]);
});

test('forked CLI history cannot kill a fresh monitor before its first resume, including beyond the hydration tail', async t => {
  const f = fixture(t);
  const { SessionManager } = loadSource('src/main/session-manager.ts', f.overrides);
  const manager = new SessionManager();
  f.disposers.push(() => manager.stop());
  const began = Date.now();
  const timed = (type, timestamp, data = {}) => JSON.stringify({ type, timestamp: new Date(timestamp).toISOString(), data }) + '\n';
  for (const n of [1, 2]) {
    const file = f.make(n, timed('session.start', began, { context: { cwd: f.home } })
      + timed('assistant.message', began - 10000, { content: n === 2 ? 'x'.repeat(2 * 1024 * 1024) : 'inherited result' })
      + timed('session.shutdown', began - 5000));
    manager.monitorCopilotSession(uuid(n), f.home);
    const info = manager.list().find(info => info.resumeSessionId === uuid(n));
    const watcher = manager.sessions.get(info.id).jsonlWatcher;
    await watcher.ready;
    assert.equal(manager.list().find(session => session.id === info.id).status, 'idle', 'an inherited shutdown predates the new fork');
    assert.notEqual(watcher.timer, null);
    fs.appendFileSync(file, timed('session.shutdown', began - 4000));
    watcher.poll();
    assert.equal(manager.list().find(session => session.id === info.id).status, 'idle', 'late copies of parent history are not live shutdowns');
    assert.notEqual(watcher.timer, null);
    fs.appendFileSync(file, timed('session.resume', began + 1, { context: { cwd: f.home } })
      + timed('assistant.turn_start', began + 2, { turnId: 'new-work' }));
    watcher.poll();
    assert.equal(manager.list().find(session => session.id === info.id).status, 'running');
    fs.appendFileSync(file, timed('session.shutdown', began + 3));
    watcher.poll();
    assert.equal(manager.list().find(session => session.id === info.id), undefined, 'the actual child shutdown removes the monitor');
  }
  assert.equal(manager.list().length, 0, 'terminated forks must not leave killed graph nodes');
});

test('an attributed sub-agent shutdown cannot stop its independently monitored parent CLI', async t => {
  const f = fixture(t);
  const file = f.make(1, record('session.start', { context: { cwd: f.home } })
    + record('assistant.turn_start', { turnId: 'parent-work' })
    + JSON.stringify({ type: 'session.shutdown', agentId: 'earlier-worker', data: {} }) + '\n');
  const { SessionManager } = loadSource('src/main/session-manager.ts', f.overrides);
  const manager = new SessionManager();
  f.disposers.push(() => manager.stop());
  manager.monitorCopilotSession(uuid(1), f.home);
  const info = manager.list()[0];
  const watcher = manager.sessions.get(info.id).jsonlWatcher;
  await watcher.ready;
  assert.equal(manager.list()[0].status, 'running');
  fs.appendFileSync(file, JSON.stringify({ type: 'session.shutdown', agentId: 'finished-worker', data: {} }) + '\n');
  watcher.poll();
  assert.equal(manager.list()[0].status, 'running');
  assert.notEqual(watcher.timer, null);
});

test('monitored CLIs replay and tail exactly once, preserve UTF-8, follow workspaces and never own processes or restore state', async t => {
  const f = fixture(t);
  const events = [];
  const file = f.make(1, record('session.start', { context: { cwd: f.home } })
    + record('user.message', { content: 'initial request' }));
  const { SessionManager } = loadSource('src/main/session-manager.ts', f.overrides);
  const manager = new SessionManager();
  manager.setWindow({ isDestroyed: () => false, webContents: { send: (channel, data) => events.push({ channel, data }) } });
  f.disposers.push(() => manager.stop());
  manager.monitorCopilotSession(uuid(1), f.home);
  const info = manager.list()[0];
  await manager.sessions.get(info.id).jsonlWatcher.ready;
  assert.equal(info.readOnly, true);
  assert.equal(info.windowsPty, undefined);
  assert.equal(info.pid, 0);
  assert.match(manager.getBuffer(info.id), /initial request/);
  assert.doesNotMatch(manager.getBuffer(info.id), /Resuming session/);
  const watcher = manager.sessions.get(info.id).jsonlWatcher;
  watcher.poll();
  assert.equal(manager.getBuffer(info.id).split('initial request').length, 2);
  const next = Buffer.from(record('assistant.message', { content: 'Native preview: \u03bb\ud83d\ude80 result.md' }));
  const split = next.indexOf(Buffer.from('\u03bb')) + 1;
  fs.appendFileSync(file, next.subarray(0, split));
  watcher.poll();
  fs.appendFileSync(file, next.subarray(split));
  watcher.poll();
  assert.match(manager.getBuffer(info.id), /Native preview: \u03bb\ud83d\ude80 result.md/);
  assert.doesNotMatch(manager.getBuffer(info.id), /\ufffd/);
  const workspace = path.join(f.home, 'mounted');
  fs.mkdirSync(workspace);
  fs.appendFileSync(file, record('session.resume', { context: { cwd: workspace } }));
  watcher.poll();
  assert.equal(manager.getCwd(info.id), workspace);
  assert.ok(events.some(event => event.channel === 'session:created' && event.data.id === info.id));
  assert.throws(() => manager.create(workspace, 'copilot', uuid(1)), /already running/);
  manager.resize(info.id, 100, 30);
  manager.saveState();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.home, '.agentplex', 'state.json'))).sessions, {});
  fs.appendFileSync(file, record('session.shutdown', {}));
  watcher.poll();
  assert.deepEqual(manager.list(), []);
  assert.equal(events.filter(event => event.channel === 'session:removed' && event.data.id === info.id).length, 1);
  assert.equal(watcher.timer, null);
  manager.kill(info.id);
  assert.deepEqual(manager.list(), []);
});

test('initial monitor hydration uses the latest workspace and does not revive a CLI that already shut down', async t => {
  const f = fixture(t);
  const mounted = path.join(f.home, 'mounted');
  fs.mkdirSync(mounted);
  f.make(1, record('session.start', { context: { cwd: f.home } })
    + record('session.shutdown', {}) + record('session.resume', { context: { cwd: mounted } })
    + record('assistant.message', { content: 'last result' }) + record('session.shutdown', {}));
  const { SessionManager } = loadSource('src/main/session-manager.ts', f.overrides);
  const manager = new SessionManager();
  f.disposers.push(() => manager.stop());
  manager.monitorCopilotSession(uuid(1), f.home);
  const session = manager.sessions.get(manager.list()[0].id);
  const watcher = session.jsonlWatcher;
  await watcher.ready;
  assert.equal(session.cwd, mounted);
  assert.deepEqual(manager.list(), []);
  assert.match(session.buffer, /last result/);
  assert.equal(watcher.timer, null);
});

test('a shutdown followed by a resume in the same watcher batch keeps the live discovered CLI', async t => {
  const f = fixture(t);
  const file = f.make(1);
  const { SessionManager } = loadSource('src/main/session-manager.ts', f.overrides);
  const manager = new SessionManager();
  f.disposers.push(() => manager.stop());
  manager.monitorCopilotSession(uuid(1), f.home);
  const info = manager.list()[0];
  await manager.sessions.get(info.id).jsonlWatcher.ready;
  fs.appendFileSync(file, record('session.shutdown', {}) + record('session.resume', { context: { cwd: f.home } }));
  manager.sessions.get(info.id).jsonlWatcher.poll();
  assert.equal(manager.list()[0].id, info.id);
  assert.equal(manager.list()[0].status, 'idle');
});

test('one inaccessible session cannot block other discoveries or repeatedly flood the log', async t => {
  const f = fixture(t);
  f.make(1); f.make(2);
  const errors = t.mock.method(console, 'error', () => {});
  const { CopilotSessionDiscovery } = loadSource('src/main/copilot-session-discovery.ts', {
    ...f.overrides, './copilot-session-scanner': { readWorkspaceCwd: async file => {
      if (file.includes(uuid(1))) throw Object.assign(new Error('denied metadata'), { code: 'EACCES' });
      return null;
    } },
  });
  const found = [];
  const discovery = new CopilotSessionDiscovery(f.root, () => false, id => found.push(id));
  f.disposers.push(() => discovery.stop());
  discovery.controller = new AbortController();
  discovery.baseline = false;
  await discovery.poll(); await discovery.poll();
  assert.deepEqual(found, [uuid(2)]);
  assert.equal(errors.mock.callCount(), 1);
});

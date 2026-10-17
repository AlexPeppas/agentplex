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
  fs.appendFileSync(old, record('assistant.message', { content: 'edited historical data' }));
  discovery.activity.add(uuid(1));
  await discovery.poll();
  assert.deepEqual(found, []);
  fs.appendFileSync(old, JSON.stringify({ type: 'session.resume', timestamp: new Date(discovery.startedAt + 100).toISOString(),
    data: { context: { cwd: f.home } } }) + '\n');
  discovery.activity.add(uuid(1));
  await discovery.poll();
  assert.deepEqual(found, [[uuid(1), f.home]]);
});

test('monitored CLIs replay and tail exactly once, preserve UTF-8, follow workspaces and never own processes or restore state', t => {
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
  assert.equal(manager.list()[0].status, 'killed');
  assert.equal(watcher.timer, null);
  manager.kill(info.id);
  assert.deepEqual(manager.list(), []);
});

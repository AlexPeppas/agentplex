const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const originalUuid = '11111111-1111-4111-8111-111111111111';
const unrelatedUuid = '22222222-2222-4222-8222-222222222222';
const thirdUuid = '33333333-3333-4333-8333-333333333333';

function fixture(t, filesystem = fs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-session-persistence-'));
  const workspace = path.join(home, 'workspace');
  const file = path.join(home, '.agentplex', 'state.json');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.dirname(file));
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    fs: filesystem, os: { ...os, homedir: () => home },
    'node-pty': {}, electron: {},
    './shell-detector': {}, './settings-manager': {},
    './claude-session-scanner': {}, './copilot-session-scanner': {},
    './plan-task-detector': {}, './config-loader': {},
  });
  const manager = new SessionManager();
  t.after(() => { manager.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return {
    home, workspace, file, manager, SessionManager,
    saved: (cli = 'copilot', resumeSessionId = originalUuid) => ({ displayName: 'Saved task', cwd: workspace, cli, resumeSessionId }),
    write(sessions) { fs.writeFileSync(file, JSON.stringify({ sessions })); },
    read() { return JSON.parse(fs.readFileSync(file, 'utf8')); },
    conversation(uuid) {
      const dir = path.join(home, '.copilot', 'session-state', uuid);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'workspace.yaml'), `cwd: ${workspace}\n`);
      fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'session.start', data: { sessionId: uuid } }) + '\n');
    },
  };
}

test('a minted Copilot UUID without history is never rebound to unrelated same-workspace history', t => {
  const f = fixture(t);
  f.write({ pending: f.saved() });
  f.conversation(unrelatedUuid);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.equal(f.manager.loadState().sessions.pending.resumeSessionId, originalUuid);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('ambiguous Copilot history preserves unresolved IDs and exact existing IDs on repeated loads', t => {
  const f = fixture(t);
  f.conversation(unrelatedUuid);
  f.conversation(thirdUuid);
  f.write({ unresolved: f.saved('copilot-resume'), existing: f.saved('copilot', thirdUuid) });
  for (let i = 0; i < 2; i++) {
    const state = f.manager.loadState();
    assert.equal(state.sessions.unresolved.resumeSessionId, originalUuid);
    assert.equal(state.sessions.existing.resumeSessionId, thirdUuid);
  }
  assert.equal(f.read().sessions.unresolved.resumeSessionId, originalUuid);
});

test('the explicit legacy Claude UUID field still migrates without guessing another identity', t => {
  const f = fixture(t);
  const saved = f.saved('claude');
  delete saved.resumeSessionId;
  saved.claudeSessionUuid = originalUuid;
  f.write({ legacy: saved });
  assert.equal(f.manager.loadState().sessions.legacy.resumeSessionId, originalUuid);
});

function active(f, id, saved) {
  const session = { id, title: saved.displayName, ...saved, status: 'idle',
    pty: { pid: 1, kill() {} }, jsonlWatcher: null };
  f.manager.sessions.set(id, session);
  return session;
}

test('partial writes and failed replacement preserve the last valid snapshot and remove temporary files', t => {
  let failWrite = false, failRename = false;
  const filesystem = {
    ...fs,
    writeFileSync(file, content, ...args) {
      if (failWrite && typeof file === 'number') {
        fs.writeSync(file, '{partial');
        throw Object.assign(new Error('synthetic disk full'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(file, content, ...args);
    },
    renameSync(from, to) {
      if (failRename && String(from).endsWith('.tmp')) throw Object.assign(new Error('synthetic replacement denied'), { code: 'EACCES' });
      return fs.renameSync(from, to);
    },
  };
  const f = fixture(t, filesystem);
  f.write({ saved: f.saved('claude') });
  const before = fs.readFileSync(f.file, 'utf8');
  active(f, 'saved', f.saved('claude'));
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  failWrite = true;
  f.manager.updateDisplayName('saved', 'Changed name');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['state.json']);
  failWrite = false; failRename = true;
  f.manager.updateDisplayName('saved', 'Another name');
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['state.json']);
  failRename = false;
  f.manager.updateDisplayName('saved', 'Persisted name');
  assert.equal(f.read().sessions.saved.displayName, 'Persisted name');
  assert.equal(errors.length, 2);
});

test('malformed state is preserved byte-for-byte before restore creates a replacement', t => {
  const f = fixture(t);
  const corrupt = '{"sessions": {"interrupted":';
  fs.writeFileSync(f.file, corrupt);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(f.manager.loadState(), { sessions: {} });
  const recovery = fs.readdirSync(path.dirname(f.file)).find(name => name.startsWith('state.json.corrupt-'));
  assert.ok(recovery);
  assert.equal(fs.readFileSync(path.join(path.dirname(f.file), recovery), 'utf8'), corrupt);
  assert.deepEqual(f.manager.restoreAll(), []);
  assert.deepEqual(f.read(), { sessions: {} });
  assert.equal(fs.readFileSync(path.join(path.dirname(f.file), recovery), 'utf8'), corrupt);
});

test('failed corruption recovery or unreadable state blocks destructive overwrites until reads recover', t => {
  let denyRead = false, denyRecovery = true;
  const filesystem = {
    ...fs,
    readFileSync(file, ...args) {
      if (denyRead && String(file).endsWith('state.json')) throw Object.assign(new Error('synthetic read denied'), { code: 'EACCES' });
      return fs.readFileSync(file, ...args);
    },
    renameSync(from, to) {
      if (denyRecovery && String(to).includes('.corrupt-')) throw Object.assign(new Error('synthetic recovery denied'), { code: 'EACCES' });
      return fs.renameSync(from, to);
    },
  };
  const f = fixture(t, filesystem);
  t.mock.method(console, 'error', () => {});
  fs.writeFileSync(f.file, '{invalid');
  assert.deepEqual(f.manager.restoreAll(), []);
  active(f, 'new', f.saved());
  f.manager.updateDisplayName('new', 'Must not overwrite');
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{invalid');
  denyRecovery = false;
  f.write({ saved: f.saved() });
  denyRead = true;
  f.manager.loadState();
  f.manager.updateDisplayName('new', 'Still must not overwrite');
  assert.ok(f.read().sessions.saved);
  denyRead = false;
  f.manager.loadState();
  f.manager.updateDisplayName('new', 'Recovered');
  assert.equal(f.read().sessions.new.displayName, 'Recovered');
});

test('invalid record shape is quarantined rather than treated as valid empty session state', t => {
  const f = fixture(t);
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  fs.writeFileSync(f.file, JSON.stringify({ sessions: { invalid: { cwd: 42 } } }));
  assert.deepEqual(f.manager.loadState(), { sessions: {} });
  assert.ok(fs.readdirSync(path.dirname(f.file)).some(name => name.startsWith('state.json.corrupt-')));
});

test('skipped records survive renames and new sessions, retry once, and never resurrect killed sessions', t => {
  const f = fixture(t);
  const offline = path.join(f.home, 'offline');
  f.write({
    'session-1': f.saved('claude'),
    'session-2': { ...f.saved('copilot', unrelatedUuid), cwd: offline },
  });
  f.manager.createWithUuid = (cwd, cli, resumeSessionId) => {
    const id = f.manager.allocateSessionId();
    const saved = { displayName: 'Restored', cwd, cli, resumeSessionId };
    active(f, id, saved);
    return { id, cwd, cli, resumeSessionId };
  };
  const first = f.manager.restoreAll();
  assert.equal(first.length, 1);
  assert.equal(f.read().sessions['session-2'].cwd, offline);
  f.manager.updateDisplayName(first[0].info.id, 'Renamed live session');
  const added = f.manager.createWithUuid(f.workspace, 'claude', thirdUuid);
  f.manager.saveState();
  assert.notEqual(added.id, 'session-2');
  assert.equal(Object.keys(f.read().sessions).length, 3);
  fs.mkdirSync(offline);
  assert.equal(f.manager.restoreAll().length, 1);
  assert.equal(f.manager.list().length, 3);
  assert.deepEqual(f.manager.restoreAll(), []);
  assert.equal(f.manager.list().length, 3);
  f.manager.kill(first[0].info.id);
  assert.equal(Object.values(f.read().sessions).some(saved => saved.resumeSessionId === originalUuid), false);
  assert.deepEqual(f.manager.restoreAll(), []);
  assert.equal(f.manager.list().length, 2);
});

test('launch failures remain recoverable without retaining unsupported or intentionally non-resumable sessions', t => {
  const f = fixture(t);
  f.write({
    failed: f.saved('copilot'),
    unsupported: f.saved('pwsh', unrelatedUuid),
    unknown: { ...f.saved('claude'), resumeSessionId: null },
  });
  t.mock.method(console, 'error', () => {});
  f.manager.createWithUuid = () => { throw new Error('synthetic launch failure'); };
  assert.deepEqual(f.manager.restoreAll(), []);
  assert.deepEqual(Object.keys(f.read().sessions), ['failed']);
});

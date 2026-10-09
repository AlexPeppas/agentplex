const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');
const uuid = '11111111-1111-4111-8111-111111111111';

function fixture(t, stage) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-session-startup-'));
  const terms = [], watchers = [], events = [];
  const failure = Object.assign(new Error(`synthetic ${stage} failure`), { code: 'EACCES' });
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    os: { ...os, homedir: () => home },
    fs: {
      ...fs,
      statSync(file, ...args) {
        if (stage === 'history' && String(file).endsWith('.jsonl')) throw failure;
        return fs.statSync(file, ...args);
      },
    },
    'node-pty': {
      spawn() {
        const term = {
          pid: 1000 + terms.length, kills: 0, writes: [],
          onData(callback) { if (stage === 'callbacks') throw failure; term.data = callback; },
          onExit(callback) { term.exit = callback; },
          kill() { term.kills++; term.exit?.({ exitCode: 1 }); },
          write(data) { term.writes.push(data); }, resize() {},
        };
        terms.push(term);
        return term;
      },
    },
    electron: {},
    './shell-detector': { getShellById: () => ({ path: 'synthetic-shell' }) },
    './settings-manager': { getDefaultShellId: () => 'synthetic-shell' },
    './claude-session-scanner': { renderJsonlTranscript: () => '' },
    './copilot-session-scanner': { renderCopilotTranscript: () => '' },
    './plan-task-detector': { PlanTaskDetector: class {
      constructor() { if (stage === 'plan') throw failure; }
      feed() {}
    } },
    './config-loader': { resolveClaudeConfig() {
      if (stage === 'config') throw failure;
      return { command: 'synthetic-claude', flags: [] };
    } },
  });
  const manager = new SessionManager();
  const createWatcher = manager.createJsonlWatcher.bind(manager);
  manager.createJsonlWatcher = (...args) => {
    const watcher = createWatcher(...args);
    watchers.push(watcher);
    return watcher;
  };
  manager.setWindow({
    isDestroyed: () => false,
    webContents: { send: (channel, event) => events.push({ channel, event }) },
  });
  t.after(() => {
    manager.stop();
    t.mock.timers.reset();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { manager, terms, watchers, events, failure, home };
}

for (const [stage, clis] of [
  ['history', ['claude', 'copilot']],
  ['plan', ['claude']],
  ['callbacks', ['claude']],
  ['config', ['claude']],
]) {
  test(`${stage} initialization failures roll back owned resources and preserve the original error`, async t => {
    const f = fixture(t, stage);
    for (const cli of clis) assert.throws(() => f.manager.create(f.home, cli, uuid), error => error === f.failure);
    await Promise.resolve();
    assert.deepEqual(f.manager.list(), []);
    assert.ok(f.terms.every(term => term.kills === 1));
    assert.ok(f.watchers.every(watcher => watcher.timer === null));
    assert.deepEqual(f.events, []);
    t.mock.timers.tick(10_000);
    assert.ok(f.terms.every(term => term.writes.length === 0));
    f.manager.stop();
    assert.ok(f.terms.every(term => term.kills === 1));
  });
}

test('successful initialization still publishes ownership, launches once and forwards output', async t => {
  const f = fixture(t);
  const info = f.manager.create(f.home, 'claude', uuid);
  await Promise.resolve();
  assert.equal(f.manager.list()[0].id, info.id);
  assert.equal(f.terms[0].kills, 0);
  t.mock.timers.tick(1000);
  assert.deepEqual(f.terms[0].writes, [`synthetic-claude --resume ${uuid}\r`]);
  f.terms[0].data('visible output\n');
  assert.equal(f.manager.getBuffer(info.id), 'visible output\n');
  assert.ok(f.events.some(event => event.channel === IPC.SESSION_DATA && event.event.data === 'visible output\n'));
  f.manager.kill(info.id);
  assert.equal(f.terms[0].kills, 1);
  assert.equal(f.watchers[0].timer, null);
});

test('killing or shutting down initialized UUID sessions cancels their pending launch timers', t => {
  const f = fixture(t);
  const first = f.manager.create(f.home, 'copilot', uuid);
  f.manager.create(f.home, 'claude', '22222222-2222-4222-8222-222222222222');
  f.manager.kill(first.id);
  f.manager.stop();
  t.mock.timers.tick(1000);
  assert.ok(f.terms.every(term => term.writes.length === 0));
  assert.ok(f.watchers.every(watcher => watcher.timer === null));
});

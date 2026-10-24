const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const uuid = '22222222-2222-4222-8222-222222222222';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-session-duplicate-'));
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  const terms = [];
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    os: { ...os, homedir: () => home },
    'node-pty': {
      spawn(_shell, _args, options) {
        const term = {
          pid: 2000 + terms.length, cwd: options.cwd, writes: [],
          onData(callback) { term.data = callback; },
          onExit(callback) { term.exit = callback; },
          kill() { term.exit?.({ exitCode: 1 }); },
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
    './plan-task-detector': { PlanTaskDetector: class { feed() {} } },
    './config-loader': { resolveClaudeConfig: () => ({ command: 'synthetic-claude', flags: ['--model', 'opus'] }) },
  });
  const manager = new SessionManager();
  manager.setWindow({ isDestroyed: () => false, webContents: { send() {} } });
  t.after(() => {
    manager.stop();
    t.mock.timers.reset();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const writeConversation = id => {
    const file = manager.getJsonlPath(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"type":"user"}\n');
  };
  const launched = term => {
    t.mock.timers.tick(1000);
    return term.writes.join('');
  };
  return { manager, terms, home, workspace, writeConversation, launched };
}

test('duplicating a Claude conversation forks it into a new persisted session in the same directory', t => {
  const f = fixture(t);
  const source = f.manager.create(f.workspace, 'claude', uuid);
  f.writeConversation(source.id);
  const sourceLaunch = f.launched(f.terms[0]);

  const copy = f.manager.fork(source.id);

  assert.notEqual(copy.id, source.id);
  assert.equal(copy.cli, 'claude');
  assert.equal(copy.cwd, f.workspace);
  assert.equal(f.terms[1].cwd, f.workspace);
  assert.match(copy.resumeSessionId, UUID_RE);
  assert.notEqual(copy.resumeSessionId, uuid);
  assert.equal(f.launched(f.terms[1]),
    `synthetic-claude --model opus --resume ${uuid} --fork-session --session-id ${copy.resumeSessionId}\r`);
  assert.equal(f.terms[0].writes.join(''), sourceLaunch, 'the source session receives no input');
  assert.deepEqual(f.manager.list().map(s => s.id).sort(), [source.id, copy.id].sort());

  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.agentplex', 'state.json'), 'utf8'));
  const persisted = Object.values(state.sessions).map(s => s.resumeSessionId);
  assert.ok(persisted.includes(copy.resumeSessionId), 'the fork is saved for restore');
});

test('duplicating a Claude session with no conversation opens an empty session in the same directory', t => {
  const f = fixture(t);
  const source = f.manager.create(f.workspace, 'claude');
  f.launched(f.terms[0]);

  const copy = f.manager.fork(source.id);

  assert.notEqual(copy.id, source.id);
  assert.equal(copy.cli, 'claude');
  assert.equal(copy.cwd, f.workspace);
  assert.notEqual(copy.resumeSessionId, source.resumeSessionId);
  const command = f.launched(f.terms[1]);
  assert.equal(command, `synthetic-claude --model opus --session-id ${copy.resumeSessionId}\r`);
  assert.doesNotMatch(command, /--fork-session|--resume/);
});

test('duplicating an ended Claude session still forks its saved conversation', t => {
  const f = fixture(t);
  const source = f.manager.create(f.workspace, 'claude', uuid);
  f.writeConversation(source.id);
  f.terms[0].kill();

  const copy = f.manager.fork(source.id);

  assert.match(f.launched(f.terms[1]), new RegExp(`--resume ${uuid} --fork-session --session-id ${copy.resumeSessionId}`));
});

test('only known Claude sessions can be duplicated', t => {
  const f = fixture(t);
  const copilot = f.manager.create(f.workspace, 'copilot');
  assert.throws(() => f.manager.fork(copilot.id), /Only Claude sessions can be duplicated/);
  assert.throws(() => f.manager.fork('missing-session'), /Only Claude sessions can be duplicated/);
  assert.equal(f.manager.list().length, 1, 'a rejected duplicate creates nothing');
});

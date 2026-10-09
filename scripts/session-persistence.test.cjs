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

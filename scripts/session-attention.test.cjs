const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const cap = 512 * 1024;

function fixture(t, uuid = false, active = true, cli = 'claude') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-attention-'));
  const log = path.join(root, 'events.jsonl');
  fs.writeFileSync(log, '{}\n');
  if (!active) fs.utimesSync(log, new Date(0), new Date(0));
  let output;
  const term = { pid: 123, onData: callback => { output = callback; }, onExit() {}, kill() {}, write() {} };
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    'node-pty': { spawn: () => term }, electron: {}, os: { ...os, homedir: () => root },
    './shell-detector': { getShellById: () => ({ path: 'synthetic-shell' }) },
    './settings-manager': { getDefaultShellId: () => 'test' },
    './claude-session-scanner': { renderJsonlTranscript: () => '' },
    './copilot-session-scanner': { renderCopilotTranscript: () => '' },
    './plan-task-detector': { PlanTaskDetector: class { feed() {} } },
    './config-loader': { resolveClaudeConfig: () => ({ command: 'synthetic-claude', flags: [] }) },
  });
  const manager = new SessionManager();
  manager.saveState = () => {};
  manager.createJsonlWatcher = () => ({ jsonlPath: log, start() {}, stop() {} });
  const info = manager.create(root, cli, uuid ? '11111111-1111-4111-8111-111111111111' : undefined);
  const session = manager.sessions.get(info.id);
  if (cli === 'raw') session.jsonlWatcher = null;
  t.after(() => { manager.stop(); t.mock.timers.reset(); fs.rmSync(root, { recursive: true, force: true }); });
  return {
    session,
    feed(data) { output(data); manager.checkStatuses(); },
  };
}

for (const [uuid, active, size] of [[false, true, cap], [true, false, cap], [false, true, cap - 40], [false, true, 4096]]) {
  test(`attention clears after substantial response, uuid=${uuid}, active=${active}, retained=${size}`, t => {
    const f = fixture(t, uuid, active);
    f.feed('x'.repeat(size - 3) + '\n> ');
    assert.equal(f.session.status, 'waiting-for-input');
    f.feed('r'.repeat(32 * 1024) + '\n');
    assert.equal(f.session.status, active ? 'running' : 'idle');
    assert.equal(f.session.waitingSince, 0);
    assert.ok(f.session.buffer.length <= cap);
  });
}

test('short redraw output still retains attention at the cap', t => {
  const f = fixture(t);
  f.feed('x'.repeat(cap - 3) + '\n> ');
  f.feed('\r\nok\r\n');
  assert.equal(f.session.status, 'waiting-for-input');
  f.feed('r'.repeat(600));
  assert.equal(f.session.status, 'running');
});

for (const cli of ['claude', 'raw']) {
  test(`ordinary JSON, code and prose do not request attention in ${cli}`, t => {
    const f = fixture(t, false, true, cli);
    for (const output of ['{"allow":false}\nBuild succeeded.\n', 'const approve = false;\nBuild succeeded.\n',
      'The policy does not allow writes.\nAnalysis continues.\n', 'Confirm that this example is correct.\n']) {
      f.feed(output);
      assert.equal(f.session.status, cli === 'claude' ? 'running' : 'idle', output);
    }
    for (const prompt of ['Continue? [Y/n]', 'Allow / Deny', 'Do you want to continue?', 'Enter to select']) {
      f.feed('x'.repeat(600) + '\n' + prompt);
      assert.equal(f.session.status, 'waiting-for-input', prompt);
      f.feed('r'.repeat(600) + '\n');
    }
  });
}

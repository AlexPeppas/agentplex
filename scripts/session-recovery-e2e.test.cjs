const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nativePty = require('node-pty');
const { loadSource } = require('./test-support.cjs');
const { encodeProjectPath } = loadSource('src/main/jsonl-session-watcher.ts');
const uuid = '11111111-1111-4111-8111-111111111111';
const offlineUuid = '22222222-2222-4222-8222-222222222222';
const addedUuid = '33333333-3333-4333-8333-333333333333';

async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

test('real PTY E2E: restore, rename, add, restart, recover offline sessions and roll back failed launches', {
  timeout: 40_000,
}, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-recovery-e2e-'));
  const workspace = path.join(home, 'workspace'), offline = path.join(home, 'offline');
  const stateFile = path.join(home, '.agentplex', 'state.json');
  const helper = path.join(home, 'synthetic-provider.cjs');
  const terms = [], managers = [];
  let denyHistory = false;
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.dirname(stateFile));
  fs.writeFileSync(helper, `
const fs = require('node:fs'), path = require('node:path');
const [root, provider, mode, id] = process.argv.slice(2);
if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Unexpected synthetic UUID');
const file = provider === 'copilot' ? path.join(root, id, 'events.jsonl') : path.join(root, id + '.jsonl');
fs.mkdirSync(path.dirname(file), { recursive: true });
const text = 'READY:' + id + ':' + mode;
const record = provider === 'copilot'
  ? { type: 'assistant.message', data: { content: text } }
  : { type: 'assistant', message: { content: [{ type: 'text', text }] } };
fs.appendFileSync(file, JSON.stringify(record) + '\\n');
console.log(text);
`);
  const quote = value => `"${value}"`;
  const command = (cwd, provider) => {
    const directory = provider === 'copilot' ? path.join(home, '.copilot', 'session-state') :
      path.join(home, '.claude', 'projects', encodeProjectPath(cwd));
    return `${quote(process.execPath)} ${quote(helper)} ${quote(directory)} ${provider}`;
  };
  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const saved = (cwd, cli, resumeSessionId) => ({ cwd, cli, resumeSessionId, displayName: `Saved ${cli}` });
  function newManager() {
    const { SessionManager } = loadSource('src/main/session-manager.ts', {
      os: { ...os, homedir: () => home },
      fs: {
        ...fs,
        statSync(file, ...args) {
          if (denyHistory && String(file).endsWith('.jsonl')) throw Object.assign(new Error('E2E history access denied'), { code: 'EACCES' });
          return fs.statSync(file, ...args);
        },
      },
      electron: {},
      './shell-detector': { getShellById: () => ({ path: process.platform === 'win32' ? process.env.ComSpec : '/bin/sh' }) },
      './settings-manager': { getDefaultShellId: () => 'test-shell' },
      './config-loader': { resolveClaudeConfig: cwd => ({ command: command(cwd, 'claude'), flags: [] }) },
      'node-pty': {
        ...nativePty,
        spawn(shell, _args, options) {
          const term = nativePty.spawn(shell, process.platform === 'win32' ? ['/d', '/q'] : ['-i'], options);
          const owned = { term, exited: false, launches: [] };
          terms.push(owned);
          term.onExit(() => { owned.exited = true; });
          const kill = term.kill.bind(term);
          term.kill = () => { if (!owned.exited) kill(); };
          const write = term.write.bind(term);
          term.write = data => {
            const copilot = data.match(/^gh copilot --(resume|session-id)=([0-9a-f-]{36})\r$/i);
            if (copilot) {
              owned.launches.push(data);
              return write(`${command(options.cwd, 'copilot')} --${copilot[1]} ${copilot[2]}\r`);
            }
            if (data.includes(helper)) owned.launches.push(data);
            return write(data);
          };
          return term;
        },
      },
    });
    const manager = new SessionManager();
    managers.push(manager);
    return manager;
  }
  t.after(async () => {
    for (const manager of managers) manager.stop();
    await until(() => terms.every(term => term.exited), 'owned PTYs to exit', 5000);
    fs.rmSync(home, { recursive: true, force: true });
  });
  fs.writeFileSync(stateFile, JSON.stringify({ sessions: {
    'session-1': saved(workspace, 'claude', uuid),
    'session-2': saved(offline, 'copilot', offlineUuid),
  } }));
  const unrelated = path.join(home, '.copilot', 'session-state', '44444444-4444-4444-8444-444444444444');
  fs.mkdirSync(unrelated, { recursive: true });
  fs.writeFileSync(path.join(unrelated, 'workspace.yaml'), `cwd: ${offline}\n`);
  fs.writeFileSync(path.join(unrelated, 'events.jsonl'), JSON.stringify({ type: 'user.message', data: { content: 'UNRELATED_HISTORY' } }) + '\n');

  const first = newManager();
  const restored = first.restoreAll();
  assert.equal(restored.length, 1);
  await until(() => first.getBuffer(restored[0].info.id).includes(`READY:${uuid}:--session-id`), 'first synthetic CLI');
  first.updateDisplayName(restored[0].info.id, 'Renamed task');
  const added = first.create(workspace, 'claude', addedUuid);
  await until(() => first.getBuffer(added.id).includes(`READY:${addedUuid}:--resume`), 'added synthetic CLI');
  assert.equal(readState().sessions['session-2'].resumeSessionId, offlineUuid);
  assert.equal(Object.keys(readState().sessions).length, 3);
  first.stop();
  await until(() => terms.every(term => term.exited), 'first generation to exit');

  fs.mkdirSync(offline);
  const restarted = newManager();
  const recovered = restarted.restoreAll();
  assert.equal(recovered.length, 3);
  for (const item of recovered) {
    await until(() => restarted.getBuffer(item.info.id).includes(`READY:${item.info.resumeSessionId}:`), 'restarted synthetic CLI');
    assert.doesNotMatch(restarted.getBuffer(item.info.id), /UNRELATED_HISTORY/);
  }
  assert.deepEqual(new Set(restarted.list().map(info => info.resumeSessionId)), new Set([uuid, offlineUuid, addedUuid]));
  assert.equal(Object.values(readState().sessions).find(item => item.resumeSessionId === uuid).displayName, 'Renamed task');
  assert.deepEqual(restarted.restoreAll(), []);
  assert.equal(restarted.list().length, 3);
  restarted.stop();
  await until(() => terms.every(term => term.exited), 'restarted generation to exit');

  const priorTerms = terms.length;
  denyHistory = true;
  t.mock.method(console, 'error', () => {});
  const failing = newManager();
  assert.deepEqual(failing.restoreAll(), []);
  assert.equal(terms.length - priorTerms, 3);
  await until(() => terms.slice(priorTerms).every(term => term.exited), 'rolled-back native PTYs to exit');
  assert.ok(terms.slice(priorTerms).every(term => term.launches.length === 0));
  assert.equal(Object.keys(readState().sessions).length, 3);
  failing.stop();
});

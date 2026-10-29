const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');

test('branch-label IPC uses one Git command without working-tree scans or upstream counting; full details remain available', async () => {
  const calls = [], handlers = new Map();
  const cwd = process.cwd();
  const operations = loadSource('src/main/git-operations.ts', {
    child_process: { execFile(_file, args, _options, callback) {
      calls.push(args);
      const stdout = args[0] === 'symbolic-ref' ? 'topic' : args[0] === 'status' ? ''
        : args[1] === '--show-toplevel' ? cwd : args[0] === 'rev-list' ? '2\t3' : 'origin/topic';
      callback(null, { stdout, stderr: '' });
    } },
  });
  loadSource('src/main/ipc-handlers.ts', {
    electron: { ipcMain: { handle: (id, handler) => handlers.set(id, handler), on() {} }, app: { getPath: () => cwd } },
    './session-manager': { sessionManager: { getSessionCwd: id => id === 'test' ? cwd : null } },
    './git-operations': operations, './shell-detector': {}, './settings-manager': {},
    './claude-session-scanner': {}, './copilot-session-scanner': {}, './config-loader': {}, './session-search': {},
  }).registerIpcHandlers();
  const invoke = handlers.get(IPC.GIT_BRANCH_INFO);
  assert.deepEqual(await invoke(null, { sessionId: 'test', details: false }),
    { current: 'topic', tracking: null, ahead: 0, behind: 0 });
  assert.deepEqual(calls, [['symbolic-ref', '--quiet', '--short', 'HEAD']]);
  calls.length = 0;
  assert.deepEqual(await invoke(null, { sessionId: 'test' }),
    { current: 'topic', tracking: 'origin/topic', ahead: 3, behind: 2 });
  assert.equal(calls.length, 5);
  assert.equal(await invoke(null, { sessionId: 'missing', details: false }), null);
});

test('branch labels fall back to detached HEAD and return null outside a repository', async () => {
  let detached = true;
  const { gitBranchName } = loadSource('src/main/git-operations.ts', {
    child_process: { execFile(_file, args, _options, callback) {
      if (detached && args[0] === 'rev-parse') callback(null, { stdout: 'abc1234\n', stderr: '' });
      else callback(new Error('not a symbolic reference or repository'));
    } },
  });
  assert.equal(await gitBranchName(process.cwd()), 'abc1234');
  detached = false;
  assert.equal(await gitBranchName(process.cwd()), null);
});

test('branch polling stays stable across status redraws, avoids overlapping requests and ignores stale workspaces', async t => {
  let effectDeps, cleanup, value;
  const timers = new Map(), requests = [];
  t.mock.method(global, 'setInterval', callback => { const id = {}; timers.set(id, callback); return id; });
  t.mock.method(global, 'clearInterval', id => timers.delete(id));
  const before = global.window;
  global.window = { agentPlex: { gitBranchInfo: (id, details) => new Promise(resolve => requests.push({ id, details, resolve })) } };
  t.after(() => { cleanup?.(); global.window = before; });
  const { useGitBranchName } = loadSource('src/renderer/hooks/useGitBranchName.ts', {
    react: {
      useState: () => [value, next => { value = next; }],
      useEffect(effect, deps) {
        if (effectDeps && deps.every((part, index) => part === effectDeps[index])) return;
        cleanup?.(); effectDeps = deps; cleanup = effect();
      },
    },
  });
  const render = (cwd = 'workspace', enabled = true) => useGitBranchName('test', cwd, enabled);
  render(); render(); render();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].details, false);
  timers.values().next().value();
  assert.equal(requests.length, 1, 'a slow query cannot accumulate concurrent polls');
  requests[0].resolve({ current: 'first' });
  await Promise.resolve();
  assert.equal(value, 'first');
  timers.values().next().value();
  render('other-workspace');
  requests[1].resolve({ current: 'stale' });
  await Promise.resolve();
  assert.equal(value, null);
  requests[2].resolve({ current: 'second' });
  await Promise.resolve();
  assert.equal(value, 'second');
  render('other-workspace', false);
  assert.equal(timers.size, 0);
  assert.equal(value, null);
});

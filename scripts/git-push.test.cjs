const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSource } = require('./test-support.cjs');
const gitOperations = loadSource('src/main/git-operations.ts');
const { IPC } = loadSource('src/shared/ipc-channels.ts');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-git-push-'));
  const origin = path.join(root, 'origin.git'), writer = path.join(root, 'writer'), reader = path.join(root, 'reader');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=AgentPlex test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    ...(cwd === origin ? ['--git-dir', origin] : []), ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '--bare', origin);
  git(root, 'init', '-b', 'main', writer);
  git(writer, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  fs.writeFileSync(path.join(writer, 'base.txt'), 'initial\n');
  git(writer, 'add', '.'); git(writer, 'commit', '-m', 'initial');
  git(writer, 'remote', 'add', 'origin', origin);
  git(writer, 'push', '-u', 'origin', 'main');
  git(root, 'clone', '-b', 'main', origin, reader);
  git(reader, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, origin, writer, reader, git,
    commit(cwd, name) {
      fs.writeFileSync(path.join(cwd, `${name}.txt`), name + '\n');
      git(cwd, 'add', '.'); git(cwd, 'commit', '-m', name);
    },
  };
}

test('successful and up-to-date pushes report success using the real subprocess result', async t => {
  const f = fixture(t);
  f.commit(f.writer, 'published');
  const expected = f.git(f.writer, 'rev-parse', 'HEAD');
  assert.equal((await gitOperations.gitPush(f.writer)).success, true);
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), expected);
  assert.equal((await gitOperations.gitPush(f.writer)).success, true);
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), expected);
});

test('rejected pushes remain failures through helper, IPC and HTTP, preserving diagnostics and remote refs', async t => {
  const f = fixture(t);
  f.commit(f.writer, 'remote-change');
  f.git(f.writer, 'push');
  f.commit(f.reader, 'divergent-change');
  const before = f.git(f.origin, 'rev-parse', 'main');
  const manager = { getSessionCwd: id => id === 'test-session' ? f.reader : null };
  const handlers = new Map();
  const electron = { ipcMain: { handle: (id, handler) => handlers.set(id, handler), on() {} }, app: { getPath: () => f.root } };
  loadSource('src/main/ipc-handlers.ts', {
    electron, './plex-ipc': { registerPlexHandlers() {} },
    './session-manager': { sessionManager: manager },
    './git-operations': gitOperations, './shell-detector': {}, './settings-manager': {},
    './claude-session-scanner': {}, './copilot-session-scanner': {}, './config-loader': {},
    './session-search': {}, './remote': {}, './remote/auth': {}, './remote/key-manager': {},
  }).registerIpcHandlers();
  const http = loadSource('src/main/remote/http-server.ts', {
    electron, '../git-operations': gitOperations,
    '../claude-session-scanner': {}, '../shell-detector': {}, '../settings-manager': {},
    './auth': { extractBearerToken: () => 'synthetic', validateToken: () => true },
  });
  t.after(() => http.stopRateLimiter());
  const helperResult = await gitOperations.gitPush(f.reader);
  const ipcResult = await handlers.get(IPC.GIT_PUSH)(null, { sessionId: 'test-session' });
  let status, httpResult;
  await http.createRequestHandler(manager)({
    method: 'POST', url: '/api/v1/git/test-session/push', headers: {}, socket: { remoteAddress: 'fixture' },
  }, {
    writeHead(value) { status = value; },
    end(value) { httpResult = JSON.parse(value); },
  });
  assert.equal(status, 200);
  for (const result of [helperResult, ipcResult, httpResult]) {
    assert.equal(result.success, false);
    assert.match(result.output, /rejected/);
    assert.match(result.output, /->/);
  }
  assert.equal(f.git(f.origin, 'rev-parse', 'main'), before);
});

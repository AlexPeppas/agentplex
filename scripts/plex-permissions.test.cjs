const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { loadSource } = require('./test-support.cjs');
const { JsonlSessionWatcher } = loadSource('src/main/jsonl-session-watcher.ts');
const requested = (requestId, permissionRequest = {}) => ({ type: 'permission.requested', data: { requestId, permissionRequest } });
const completed = requestId => ({ type: 'permission.completed', data: { requestId } });
const jsonl = records => records.map(record => JSON.stringify(record) + '\n').join('');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-permission-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('watcher skips old approvals, bounds optional details, and drains partial final appends', async t => {
  const root = directory(t);
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, jsonl([requested('old')]));
  const watcher = new JsonlSessionWatcher(file, 'copilot', true);
  const events = [];
  watcher.on('permission-requested', event => events.push(event));
  watcher.on('permission-completed', event => events.push(event));
  watcher.start();
  t.after(() => watcher.stop());
  await settle();
  fs.appendFileSync(file, jsonl([requested('new', {
    kind: 'shell', toolName: 'powershell', fullCommandText: 'Get-Content sample.txt',
    intention: 'Read sample', path: 'sample.txt', secret: 'not-forwarded',
  }), requested('large', { description: 'x'.repeat(5000) })]));
  const final = JSON.stringify(completed('new'));
  fs.appendFileSync(file, final.slice(0, 25));
  watcher.flush();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { requestId: 'new', kind: 'shell', toolName: 'powershell',
    command: 'Get-Content sample.txt', description: 'Read sample', resource: 'sample.txt' });
  assert.equal(events[1].description.length, 4000);
  fs.appendFileSync(file, final.slice(25) + '\n');
  watcher.flush();
  assert.deepEqual(events[2], { requestId: 'new' });
});

function cliFixture(t, onPermission = async () => {}, options = {}) {
  const root = directory(t);
  const previous = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'synthetic-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previous;
  });
  const launches = [];
  const { runPlexCli } = loadSource('src/main/plex-cli.ts', {
    'node:child_process': { spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin.end = () => {};
      child.exitCode = null;
      const id = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
      const file = path.join(options.env.COPILOT_HOME, 'session-state', id, 'events.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, '');
      const launch = { child, args, file, killed: false,
        append: (...records) => fs.appendFileSync(file, jsonl(records)),
        finish: () => {
          child.stdout.emit('data', jsonl([
            { type: 'assistant.message', data: { content: '{"summary":"done"}' } }, { type: 'result', exitCode: 0 },
          ]));
          child.exitCode = 0;
          child.emit('close', 0);
        } };
      child.kill = () => { launch.killed = true; queueMicrotask(() => child.emit('close', null)); };
      launches.push(launch);
      return child;
    } },
  });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const req = { cwd: root, conversationHome: path.join(root, 'worker'), prompt: 'Synthetic',
    schema: {}, readOnly: true, signal: controller.signal, onPermission, ...options };
  return { launches, controller, run: (patch = {}) => runPlexCli({ ...req, ...patch }) };
}

test('CLI final drain orders permission delivery before result and resume never replays old requests', async t => {
  const events = [];
  const f = cliFixture(t, async event => { await Promise.resolve(); events.push(event); });
  const turn = f.run();
  await settle();
  f.launches[0].append(requested('p'), requested('p'), completed('p'), requested('p'), completed('p'));
  f.launches[0].finish();
  assert.deepEqual(await turn, { summary: 'done' });
  assert.deepEqual(events.map(event => event.status), ['requested', 'completed']);
  const resumed = f.run();
  await settle();
  assert.equal(f.launches[1].args[0], '--resume');
  f.launches[1].finish();
  await resumed;
  assert.equal(events.length, 2);
});

test('CLI pauses the execution budget until every pending permission completes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = cliFixture(t);
  const turn = f.run();
  const rejected = assert.rejects(turn, /one-hour worker execution/);
  await settle();
  const launch = f.launches[0];
  t.mock.timers.tick(3_560_000);
  launch.append(requested('one'), requested('two'));
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(300_000);
  launch.append(completed('one'));
  t.mock.timers.tick(500);
  t.mock.timers.tick(200_000);
  assert.equal(launch.killed, false);
  launch.append(completed('two'));
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(39_499);
  assert.equal(launch.killed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(launch.killed, true);
});

test('CLI permission wait has an independent ten-minute deadline and duplicate requests do not reset it', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = cliFixture(t);
  const turn = f.run();
  const rejected = assert.rejects(turn, /permission wait exceeded ten minutes/);
  await settle();
  const launch = f.launches[0];
  launch.append(requested('p'));
  t.mock.timers.tick(500);
  await settle();
  t.mock.timers.tick(300_000);
  launch.append(requested('p'));
  t.mock.timers.tick(500);
  t.mock.timers.tick(299_499);
  assert.equal(launch.killed, false);
  t.mock.timers.tick(1);
  await rejected;
});

test('CLI cannot return success with an unresolved permission, and a missing event does not pause execution', async t => {
  const events = [];
  const f = cliFixture(t, async event => { events.push(event); });
  const turn = f.run();
  const rejected = assert.rejects(turn, /unresolved permission/);
  await settle();
  fs.appendFileSync(f.launches[0].file, JSON.stringify(requested('p')));
  f.launches[0].finish();
  await rejected;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const resumed = f.run();
  const timeout = assert.rejects(resumed, /one-hour worker execution/);
  await settle();
  t.mock.timers.tick(3_600_000);
  await timeout;
  assert.equal(events.length, 1, 'final drain must not replay an unterminated historical request');
});

test('CLI permission publication failure terminates execution and reports the failure', async t => {
  const f = cliFixture(t, async () => { throw new Error('Synthetic broker failure'); });
  const turn = f.run();
  const rejected = assert.rejects(turn, /Cannot publish worker permission event: Synthetic broker failure/);
  await settle();
  f.launches[0].append(requested('p'));
  f.launches[0].finish();
  await rejected;
});

test('watcher read failures stop polling and surface through the owner error channel', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const root = directory(t);
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, '');
  const { JsonlSessionWatcher: FailingWatcher } = loadSource('src/main/jsonl-session-watcher.ts', {
    fs: { ...fs, openSync: () => { throw Object.assign(new Error('Denied'), { code: 'EACCES' }); } },
  });
  const watcher = new FailingWatcher(file, 'copilot', true);
  let failure;
  watcher.on('watch-error', error => { failure = error; });
  watcher.start();
  await settle();
  t.mock.timers.tick(500);
  assert.equal(failure.message, 'Denied');
  assert.equal(watcher.timer, null);
});

test('CLI streams split JSONL chunks before exit, coalesces message deltas and preserves the final result', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const batches = [];
  const f = cliFixture(t, undefined, { model: 'synthetic/model-v1', onActivity: async events => { batches.push(events); } });
  const turn = f.run();
  await settle();
  const launch = f.launches[0];
  assert.equal(launch.args[launch.args.indexOf('--stream') + 1], 'on');
  assert.equal(launch.args[launch.args.indexOf('--model') + 1], 'synthetic/model-v1');
  const records = jsonl([
    { type: 'assistant.turn_start', id: 'turn', data: {} },
    { type: 'assistant.reasoning_delta', data: { deltaContent: 'PRIVATE_REASONS_NOT_FOR_UI' } },
    { type: 'assistant.message_delta', data: { messageId: 'm', deltaContent: 'Working ' } },
    { type: 'assistant.message_delta', data: { messageId: 'm', deltaContent: 'now' } },
    { type: 'tool.execution_start', data: { toolCallId: 'tool', toolName: 'view', arguments: { path: 'sample.txt' } } },
  ]);
  launch.child.stdout.emit('data', records.slice(0, 45));
  launch.child.stdout.emit('data', records.slice(45));
  t.mock.timers.tick(100);
  await settle();
  assert.ok(batches.flat().some(event => event.text === 'Working now'));
  assert.ok(batches.flat().some(event => event.text.includes('sample.txt')));
  assert.equal(JSON.stringify(batches).includes('PRIVATE_REASONS_NOT_FOR_UI'), false);
  assert.equal(launch.killed, false);
  launch.finish();
  assert.deepEqual(await turn, { summary: 'done' });
  await assert.rejects(f.run({ model: 'different-model' }), /mismatched/);
  const resumed = f.run();
  await settle();
  assert.equal(f.launches[1].args[0], '--resume');
  f.launches[1].finish();
  await resumed;
});

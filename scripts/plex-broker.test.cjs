const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');
const { PlexBroker } = loadSource('src/main/plex-broker.ts');
const { PlexWorker } = loadSource('src/main/plex-worker.ts');
const { parseCopilotOutput } = loadSource('src/main/plex-cli.ts');
const task = (id, dependsOn = []) => ({ id, title: id, instructions: 'Read sample', acceptance: 'Cite file',
  agentId: null, memberIndex: 0, dependsOn });
const completed = { status: 'completed', summary: 'Done', evidence: ['sample:1'], limitations: [] };
const blocked = { status: 'blocked', summary: 'Need user input', evidence: [], limitations: ['Missing requirement'] };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-broker-test-'));
  const file = path.join(root, 'broker.json');
  let now = 1000;
  const broker = new PlexBroker(file, () => {}, () => now, 100);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file, broker, advance: value => { now += value; } };
}

test('enqueue is durable and idempotent; claims are worker-scoped, atomic, leased and concurrency limited', async t => {
  const { broker, file } = fixture(t);
  const assignments = [
    { task: task('a'), workerId: 'one' }, { task: task('b'), workerId: 'one' },
    { task: task('c'), workerId: 'two' }, { task: task('d'), workerId: 'three' },
  ];
  const jobs = broker.enqueue('mission', assignments);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.length, 4);
  assert.deepEqual(broker.enqueue('mission', assignments), jobs);
  assert.throws(() => broker.enqueue('mission', [{ task: task('different'), workerId: 'one' }]), /different/);
  assert.equal(broker.claim('foreign', 'mission'), null);
  const [first, duplicate] = await Promise.all([
    Promise.resolve().then(() => broker.claim('one', 'mission')),
    Promise.resolve().then(() => broker.claim('one', 'mission')),
  ]);
  assert.equal(first.task.id, 'a');
  assert.equal(duplicate, null);
  assert.ok(first.claimToken);
  assert.equal(first.leaseUntil, 1100);
  assert.ok(broker.claim('two', 'mission'));
  assert.equal(broker.claim('three', 'mission'), null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).jobs.filter(job => job.status === 'running').length, 2);
});

test('results authenticate claims, reject conflicting duplicates and unblock dependencies', t => {
  const { broker } = fixture(t);
  broker.enqueue('mission', [{ task: task('a'), workerId: 'one' }, { task: task('b', ['a']), workerId: 'two' }]);
  assert.equal(broker.claim('two', 'mission'), null);
  const a = broker.claim('one', 'mission');
  assert.throws(() => broker.submit(a.id, 'two', a.claimToken, completed), /another worker/);
  assert.throws(() => broker.submit(a.id, 'one', 'wrong', completed), /another worker/);
  assert.throws(() => broker.submit(a.id, 'one', a.claimToken, { ...completed, status: 'idle' }), /Invalid/);
  const item = broker.submit(a.id, 'one', a.claimToken, completed);
  assert.equal(item.source, 'worker');
  assert.equal(item.status, undefined);
  assert.equal(item.result.status, 'completed');
  assert.equal(item.jobId, a.id);
  assert.deepEqual(broker.submit(a.id, 'one', a.claimToken, completed), item);
  assert.equal(broker.results('mission').length, 1);
  assert.throws(() => broker.submit(a.id, 'one', a.claimToken, blocked), /Conflicting/);
  assert.equal(broker.claim('two', 'mission').task.id, 'b');
});

test('worker blocked results propagate transitively but leave independent jobs runnable', t => {
  const { broker } = fixture(t);
  broker.enqueue('m', [
    { task: task('a'), workerId: 'one' }, { task: task('b', ['a']), workerId: 'two' },
    { task: task('c', ['b']), workerId: 'two' }, { task: task('d'), workerId: 'two' },
  ]);
  const a = broker.claim('one', 'm');
  broker.submit(a.id, 'one', a.claimToken, blocked);
  assert.deepEqual(broker.jobs('m').map(job => job.status), ['blocked', 'blocked', 'blocked', 'queued']);
  assert.deepEqual(broker.results('m').map(item => item.source), ['worker', 'broker', 'broker']);
  assert.equal(broker.claim('two', 'm').task.id, 'd');
});

test('lease heartbeat extends ownership; expiry blocks without redelivery and rejects late results', t => {
  const { broker, advance } = fixture(t);
  broker.enqueue('m', [{ task: task('a'), workerId: 'one' }]);
  const job = broker.claim('one', 'm');
  advance(80);
  broker.heartbeat(job.id, 'one', job.claimToken);
  advance(80);
  broker.sweep();
  assert.equal(broker.jobs('m')[0].status, 'running');
  advance(21);
  broker.sweep();
  assert.equal(broker.jobs('m')[0].status, 'blocked');
  assert.match(broker.results('m')[0].result.summary, /lease expired/);
  assert.equal(broker.claim('one', 'm'), null);
  assert.throws(() => broker.submit(job.id, 'one', job.claimToken, completed), /stale/);
});

test('restart recovers uncertain jobs into blocked result records, preserving completed results', t => {
  const { broker, file } = fixture(t);
  broker.enqueue('m', [
    { task: task('a'), workerId: 'one' }, { task: task('b'), workerId: 'two' }, { task: task('c'), workerId: 'three' },
  ]);
  const a = broker.claim('one', 'm');
  broker.submit(a.id, 'one', a.claimToken, completed);
  broker.claim('two', 'm');
  const restored = new PlexBroker(file);
  restored.recover();
  assert.deepEqual(restored.jobs('m').map(job => job.status), ['completed', 'blocked', 'blocked']);
  assert.equal(restored.results('m').length, 3);
  restored.recover();
  assert.equal(restored.results('m').length, 3);
  assert.equal(restored.claim('two', 'm'), null);
});

test('cancel produces terminal result records; future missions with reused task IDs are isolated', t => {
  const { broker } = fixture(t);
  broker.enqueue('m1', [{ task: task('a'), workerId: 'one' }]);
  const first = broker.claim('one', 'm1');
  broker.cancel('m1');
  const second = broker.enqueue('m2', [{ task: task('a'), workerId: 'one' }])[0];
  assert.notEqual(first.id, second.id);
  assert.throws(() => broker.submit(first.id, 'one', first.claimToken, completed), /stale/);
  assert.equal(broker.jobs('m2')[0].status, 'queued');
  const claim = broker.claim('one', 'm2');
  broker.submit(claim.id, 'one', claim.claimToken, completed);
  assert.equal(broker.results('m1')[0].result.status, 'blocked');
  assert.equal(broker.results('m2')[0].result.status, 'completed');
});

test('broker rolls back in-memory claims when persistence fails', t => {
  const { root } = fixture(t);
  let fail = false;
  const { PlexBroker: FailingBroker } = loadSource('src/main/plex-broker.ts', {
    'node:fs': { ...fs, renameSync: (...args) => {
      if (fail) throw new Error('Disk full');
      return fs.renameSync(...args);
    } },
  });
  const broker = new FailingBroker(path.join(root, 'fail.json'));
  broker.enqueue('m', [{ task: task('a'), workerId: 'one' }]);
  fail = true;
  assert.throws(() => broker.claim('one', 'm'), /Disk full/);
  assert.equal(broker.jobs('m')[0].status, 'queued');
  fail = false;
  assert.ok(broker.claim('one', 'm'));
});

test('a worker executes an owned ready job with prerequisite evidence and publishes its result', async t => {
  const { broker, root } = fixture(t);
  broker.enqueue('m', [{ task: task('a'), workerId: 'one' }, { task: task('b', ['a']), workerId: 'two' }]);
  const a = broker.claim('one', 'm');
  let calls = 0;
  const worker = new PlexWorker({ id: 'two', provider: 'copilot', cwd: root, name: 'Reviewer', squadId: 's', squadName: 'S', status: 'idle' },
    broker, async req => {
      calls++;
      const message = JSON.parse(req.prompt);
      assert.equal(message.jobId, broker.jobs('m')[1].id);
      assert.equal(message.prerequisites[0].result.status, 'completed');
      return blocked;
    }, path.join(root, 'worker-conversation'));
  assert.equal(broker.claim('two', 'm'), null, 'dependencies must finish before a job can be claimed');
  assert.equal(calls, 0);
  broker.submit(a.id, 'one', a.claimToken, completed);
  const claimed = broker.claim('two', 'm');
  await worker.execute(claimed, new AbortController().signal, async result =>
    broker.submit(claimed.id, 'two', claimed.claimToken, result));
  assert.equal(calls, 1);
  assert.equal(broker.results('m')[1].source, 'worker');
  assert.equal(broker.results('m')[1].result.summary, 'Need user input');
});

test('Copilot JSONL parser requires a final assistant answer and successful transport completion', () => {
  const message = content => JSON.stringify({ type: 'assistant.message', data: { content, toolRequests: [] } });
  const finish = JSON.stringify({ type: 'result', exitCode: 0 });
  assert.deepEqual(parseCopilotOutput(message(JSON.stringify(completed)) + '\n' + finish), completed);
  assert.throws(() => parseCopilotOutput(message('{}')), /successful result/);
  assert.throws(() => parseCopilotOutput(message('{}') + '\n' + JSON.stringify({ type: 'result', exitCode: 1 })), /successfully/);
  assert.throws(() => parseCopilotOutput(message('Plain text instead of JSON') + '\n' + finish), /JSON/);
});

test('permission records are durable, claim-scoped, idempotent and cannot reopen after resolution', t => {
  const { broker, file, advance } = fixture(t);
  broker.enqueue('m', [{ task: task('a'), workerId: 'one' }]);
  const job = broker.claim('one', 'm');
  const event = { requestId: 'p', status: 'requested', kind: 'shell', command: 'Get-Content sample.txt' };
  assert.throws(() => broker.permission(job.id, 'wrong', job.claimToken, event), /claim/);
  assert.throws(() => broker.permission(job.id, 'one', 'wrong-token', event), /claim/);
  assert.throws(() => broker.permission(job.id, 'one', job.claimToken, { ...event, command: {} }), /details/);
  broker.permission(job.id, 'one', job.claimToken, event);
  broker.permission(job.id, 'one', job.claimToken, event);
  const permissions = broker.jobs('m')[0].permissions;
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].status, 'pending');
  assert.deepEqual(new PlexBroker(file).jobs('m')[0].permissions, permissions);
  assert.equal(broker.claim('one', 'm'), null);
  assert.throws(() => broker.submit(job.id, 'one', job.claimToken, completed), /unresolved permission/);
  advance(80);
  broker.heartbeat(job.id, 'one', job.claimToken);
  advance(80);
  broker.sweep();
  assert.equal(broker.jobs('m')[0].status, 'running');
  broker.permission(job.id, 'one', job.claimToken, { requestId: 'p', status: 'completed' });
  broker.permission(job.id, 'one', job.claimToken, event);
  assert.equal(broker.jobs('m')[0].permissions[0].status, 'resolved');
  broker.submit(job.id, 'one', job.claimToken, completed);
  broker.permission(job.id, 'one', job.claimToken, { ...event, requestId: 'late' });
  assert.equal(broker.jobs('m')[0].permissions.length, 1);
});

test('cancellation, worker failure, lease expiry and restart interrupt pending permission cards without replay', t => {
  for (const ending of ['cancel', 'failure', 'expired', 'restart']) {
    const { broker, file, advance } = fixture(t);
    broker.enqueue('m', [{ task: task('a'), workerId: 'one' }]);
    const job = broker.claim('one', 'm');
    broker.permission(job.id, 'one', job.claimToken, { requestId: 'p', status: 'requested' });
    let final = broker;
    if (ending === 'cancel') broker.cancel('m');
    if (ending === 'failure') broker.submit(job.id, 'one', job.claimToken, blocked);
    if (ending === 'expired') { advance(101); broker.sweep(); }
    if (ending === 'restart') { final = new PlexBroker(file); final.recover(); }
    assert.equal(final.jobs('m')[0].permissions[0].status, 'interrupted', ending);
    assert.equal(final.jobs('m')[0].status, 'blocked', ending);
    final.permission(job.id, 'one', job.claimToken, { requestId: 'p', status: 'requested' });
    assert.equal(final.claim('one', 'm'), null);
    assert.equal(final.jobs('m')[0].permissions[0].status, 'interrupted');
  }
});

test('worker keeps heartbeating while explicit permission requests are pending', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'] });
  const { root } = fixture(t);
  const broker = new PlexBroker(path.join(root, 'heartbeat.json'));
  broker.enqueue('m', [{ task: task('a'), workerId: 'one' }]);
  const job = broker.claim('one', 'm');
  let release;
  const worker = new PlexWorker({ id: 'one', name: 'Architect', provider: 'copilot', cwd: root },
    broker, async req => {
      await req.onPermission({ requestId: 'p', status: 'requested' });
      await new Promise(resolve => { release = resolve; });
      return blocked;
    }, path.join(root, 'worker'));
  const run = worker.execute(job, new AbortController().signal,
    async result => broker.submit(job.id, 'one', job.claimToken, result));
  await Promise.resolve();
  for (let count = 0; count < 20; count++) {
    t.mock.timers.tick(5000);
    broker.sweep();
    assert.equal(broker.jobs('m')[0].status, 'running');
    assert.equal(broker.jobs('m')[0].permissions[0].status, 'pending');
    assert.equal(broker.claim('one', 'm'), null);
  }
  release();
  await run;
  assert.equal(broker.jobs('m')[0].permissions[0].status, 'interrupted');
});

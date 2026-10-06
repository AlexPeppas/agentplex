const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { fakeAmqp } = require('./plex-fake-amqp.cjs');
const { PlexBroker } = loadSource('src/main/plex-broker.ts');

const result = { status: 'completed', summary: 'Synthetic result', evidence: [], limitations: [] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-rabbit-test-'));
  const fake = fakeAmqp();
  const { createRabbitDispatch, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts', { amqplib: fake.amqp });
  const broker = new PlexBroker(path.join(root, 'broker.json'));
  const agents = ['dev-arch', 'dev-quality', 'dev-extra'].map((name, id) => ({
    id: String(id), name, provider: 'copilot', cwd: root, squadId: 's', squadName: 'S', status: 'idle',
  }));
  const controller = new AbortController();
  t.after(() => { controller.abort(); fs.rmSync(root, { recursive: true, force: true }); });
  const enqueue = (items, missionId = 'm') => broker.enqueue(missionId, items.map(([id, worker, dependsOn = []]) => ({
    workerId: String(worker), task: { id, title: id, instructions: id, acceptance: id, dependsOn, agentId: String(worker), memberIndex: null },
  })));
  const run = execute => createRabbitDispatch(root)({ broker, agents, signal: controller.signal, missionId: 'm', execute });
  return { root, fake, broker, agents, controller, enqueue, run, queue: id => plexWorkerQueue(root, String(id)) };
}

test('RabbitMQ routes per consumer, preserves dependency order, caps concurrency and returns confirmed results', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['dependent', 0, ['first']], ['first', 0], ['other', 1], ['extra', 2]]);
  let active = 0;
  let high = 0;
  const workers = new Set();
  const order = [];
  await f.run(async (agent, job, signal, submit) => {
    assert.ok(!workers.has(agent.id));
    workers.add(agent.id);
    high = Math.max(high, ++active);
    order.push(job.task.id);
    await new Promise(resolve => setTimeout(resolve, 5));
    workers.delete(agent.id);
    active--;
    await submit(result);
  });
  assert.equal(high, 2);
  assert.ok(order.indexOf('first') < order.indexOf('dependent'));
  assert.equal(f.broker.results('m').length, 4);
  assert.ok(f.fake.publications.every(item => item.options.persistent && item.options.mandatory));
  assert.ok(f.fake.publications.filter(item => item.exchange.endsWith('.asks')).every(item => item.key === f.queue(item.payload.workerId)));
  assert.ok(f.fake.connections.every(connection => connection.closed));
});

test('duplicate deliveries and duplicate results never execute a job twice', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.fake.duplicateAsks = true;
  f.enqueue([['a', 0], ['b', 0]]);
  const calls = [];
  await f.run(async (agent, job, signal, submit) => {
    calls.push(job.id);
    await submit(result);
    await submit(result);
  });
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls).size, 2);
  assert.equal(f.broker.results('m').length, 2);
});

test('blocked results prevent dependent publication', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0], ['b', 1, ['a']]]);
  await f.run(async (agent, job, signal, submit) => submit({ ...result, status: 'blocked' }));
  assert.deepEqual(f.broker.jobs('m').map(job => job.status), ['blocked', 'blocked']);
  assert.equal(f.fake.publications.filter(item => item.exchange.endsWith('.asks')).length, 1);
});

test('broker connection and publication failures are explicit and do not fall back to direct execution', async t => {
  const f = fixture(t);
  f.enqueue([['a', 0]]);
  let calls = 0;
  f.fake.failConnect = true;
  await assert.rejects(f.run(async () => { calls++; }), /Cannot connect to RabbitMQ/);
  f.fake.failConnect = false;
  f.fake.failPublish = true;
  await assert.rejects(f.run(async () => { calls++; }), /did not confirm/);
  assert.equal(calls, 0);
  assert.equal(f.broker.jobs('m')[0].status, 'queued');
});

test('cancellation aborts a running consumer and releases the connection', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0]]);
  await f.run(async (agent, job, signal) => {
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    f.controller.abort();
    await aborted;
  });
  assert.ok(f.fake.connections[0].closed);
  assert.equal(f.broker.results('m').length, 0);
});

test('connection loss interrupts execution and rejects rather than silently reconnecting', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0]]);
  await assert.rejects(f.run(async (agent, job, signal) => {
    const aborted = new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    f.fake.connections[0].emit('error', new Error('Synthetic disconnect'));
    await aborted;
  }), /RabbitMQ connection failed/);
  assert.equal(f.fake.connections.length, 1);
});

test('queue identity is independent of a consumer display name', t => {
  const f = fixture(t);
  const before = f.queue(f.agents[0].id);
  f.agents[0].name = 'renamed';
  assert.equal(f.queue(f.agents[0].id), before);
  assert.notEqual(f.queue('0'), f.queue('1'));
});

test('a misrouted ask is dead-lettered, not executed', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0]]);
  f.fake.transform = (exchange, item) => exchange.endsWith('.asks') ? { ...item, workerId: '1' } : item;
  let calls = 0;
  await assert.rejects(f.run(async () => { calls++; }), /wrong consumer/);
  assert.equal(calls, 0);
  assert.equal([...f.fake.queues.entries()].find(([name]) => name.endsWith('.dead'))[1].messages.length, 1);
});

test('results with another workers claim cannot become completed', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0]]);
  f.fake.transform = (exchange, item) => exchange === '' ? { ...item, claimToken: 'wrong-token' } : item;
  await assert.rejects(f.run(async (agent, job, signal, submit) => submit(result)), /claim|owner/i);
  assert.equal(f.broker.results('m').length, 0);
  assert.equal([...f.fake.queues.entries()].find(([name]) => name.endsWith('.dead'))[1].messages.length, 1);
});

test('restart drains old terminal deliveries without replaying their work', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const prior = f.enqueue([['old', 0]], 'old-mission')[0];
  f.broker.recover();
  f.enqueue([['current', 0]]);
  // Install a durable stale delivery before the first new ask is published.
  f.fake.transform = (exchange, item) => {
    if (exchange.endsWith('.asks')) {
      const queue = f.fake.queues.get(f.queue(0));
      queue.messages.push({ content: Buffer.from(JSON.stringify({
        version: 1, missionId: 'old-mission', jobId: prior.id, workerId: '0',
      })), properties: {}, fields: {} });
    }
    return item;
  };
  const calls = [];
  await f.run(async (agent, job, signal, submit) => { calls.push(job.task.id); await submit(result); });
  assert.deepEqual(calls, ['current']);
  assert.equal(f.broker.jobs('old-mission')[0].status, 'blocked');
});

test('permission events are confirmed and persisted before terminal results without releasing the worker slot', { timeout: 5000 }, async t => {
  const f = fixture(t);
  f.enqueue([['a', 0], ['b', 0]]);
  f.fake.duplicateAsks = true;
  let calls = 0;
  await f.run(async (agent, job, signal, submit, permission) => {
    calls++;
    await permission({ requestId: 'p', status: 'requested', description: 'Synthetic request' });
    await permission({ requestId: 'p', status: 'requested' });
    assert.equal(f.broker.jobs('m').find(item => item.id === job.id).permissions.length, 1);
    assert.equal(f.broker.jobs('m').find(item => item.id === job.id).status, 'running');
    assert.equal(f.broker.claim(agent.id, 'm'), null);
    await permission({ requestId: 'p', status: 'completed' });
    await submit(result);
  });
  assert.equal(calls, 2);
  assert.ok(f.broker.jobs('m').every(job => job.permissions[0].status === 'resolved'));
  assert.ok(f.fake.publications.filter(p => p.payload.eventType === 'permission')
    .every(p => p.options.persistent && p.payload.claimToken));
});

test('foreign permission claims and wrong conversation affinity are dead-lettered without creating cards', { timeout: 5000 }, async t => {
  for (const field of ['claimToken', 'conversationId']) {
    const f = fixture(t);
    Object.assign(f.agents[0], { conversationId: 'chat-a', rootJobId: 'root-a', blueprintAgentId: 'arch' });
    f.enqueue([['a', 0]]);
    f.fake.transform = (exchange, item) => item.eventType === 'permission' ? { ...item, [field]: 'foreign' } : item;
    await assert.rejects(f.run(async (agent, job, signal, submit, permission) => {
      await permission({ requestId: 'p', status: 'requested' });
    }), /claim|affinity/i);
    assert.equal(f.broker.jobs('m')[0].permissions, undefined);
    assert.equal([...f.fake.queues.entries()].find(([name]) => name.endsWith('.dead'))[1].messages.length, 1);
  }
});

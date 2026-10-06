const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');
const { fakeAmqp } = require('./plex-fake-amqp.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const result = { status: 'completed', summary: 'Done', evidence: [], limitations: [] };
const { PlexBroker } = loadSource('src/main/plex-broker.ts');

function fixture(t, hooks = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-steering-test-'));
  const fake = fakeAmqp();
  const calls = [];
  const updates = [];
  const steered = [];
  const ready = deferred();
  const release = deferred();
  let active = 0;
  const { PlexHarness } = loadSource('src/main/plex-harness.ts', { amqplib: fake.amqp });
  const runner = async req => {
    calls.push(req);
    const input = JSON.parse(req.prompt);
    if (req.schema.properties.tasks) return { message: 'Review', squadId: null,
      tasks: input.resources.agents.map((agent, index) => ({
        id: `review-${index}`, title: 'Review', instructions: 'Read sample', acceptance: 'Cite evidence',
        dependsOn: [], agentId: agent.id, memberIndex: null,
      })) };
    if (req.schema.properties.requests) {
      if (hooks.followup) return hooks.followup(req, input);
      return { message: 'I will relay that refinement.', requests: [{ agentId: input.resources.agents[0].id, prompt: 'Review the edge case too.' }] };
    }
    if (req.readOnly) {
      req.registerSteering(async prompt => {
        if (hooks.sendError) throw new Error(hooks.sendError);
        steered.push(prompt);
        if (hooks.send) return hooks.send(prompt);
        return `provider-${steered.length}`;
      });
      if (++active === (hooks.workers ?? 1)) ready.resolve();
      await Promise.race([release.promise, new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }))]);
      req.registerSteering(null);
    } else if (hooks.synthesize) await hooks.synthesize(req);
    return result;
  };
  const harness = new PlexHarness(home, runner, state => updates.push(state));
  harness.saveBlueprint({ id: 'squad', name: 'Squad', revision: 1,
    agents: Array.from({ length: hooks.workers ?? 1 }, (_, index) => ({
      id: `arch-${index}`, name: `Architect ${index}`, description: 'Architecture', instructions: '', tools: ['view'],
    })) });
  harness.createConversation(home, 'squad', 'chat');
  t.after(() => { harness.dispose(); release.resolve(); fs.rmSync(home, { recursive: true, force: true }); });
  const start = async () => {
    await harness.chat('chat', 'initial', 'Review sample');
    const operation = harness.approve('chat', harness.snapshot().states.chat.approvalId);
    await ready.promise;
    return { operation };
  };
  return { home, fake, calls, updates, steered, harness, release, start };
}

test('Plex steers one live worker through an independent control queue without second approval, process or assignment', async t => {
  const f = fixture(t);
  const { operation } = await f.start();
  const before = f.harness.snapshot().states.chat;
  await f.harness.chat('chat', 'refinement', 'Also cover the edge case');
  const after = f.harness.snapshot().states.chat;
  assert.equal(after.phase, 'running');
  assert.equal(after.brainBusy, undefined);
  assert.equal(after.plan, null);
  assert.equal(after.missionId, before.missionId);
  assert.equal(after.tasks[0].jobId, before.tasks[0].jobId);
  assert.deepEqual(f.steered, ['Review the edge case too.']);
  assert.equal(after.steering[0].status, 'accepted');
  assert.equal(after.steering[0].providerMessageId, 'provider-1');
  assert.equal(f.calls.filter(req => req.readOnly).length, 1);
  assert.ok(f.fake.publications.some(item => item.key.endsWith('.control') && item.payload.jobId === before.tasks[0].jobId));
  await f.harness.chat('chat', 'refinement', 'Also cover the edge case');
  assert.equal(f.steered.length, 1, 'retrying the ingress ID cannot redeliver steering');
  f.release.resolve();
  await operation;
  assert.equal(f.harness.snapshot().states.chat.tasks[0].status, 'completed');
});

test('a conversational follow-up does not route to a worker or hold its work', async t => {
  const f = fixture(t, { followup: async () => ({ message: 'A queue decouples delivery from execution.', requests: [] }) });
  const { operation } = await f.start();
  await f.harness.chat('chat', 'question', 'Explain a queue');
  const state = f.harness.snapshot().states.chat;
  assert.equal(state.phase, 'running');
  assert.equal(f.steered.length, 0);
  assert.ok(state.messages.some(message => message.text.includes('decouples')));
  f.release.resolve();
  await operation;
});

test('one Plex turn can steer both running workers without crossing their assignment claims', async t => {
  const f = fixture(t, { workers: 2, followup: async (req, input) => ({
    message: 'Refine both reviews',
    requests: input.resources.agents.map((agent, index) => ({ agentId: agent.id, prompt: `Refinement ${index}` })),
  }) });
  const { operation } = await f.start();
  await f.harness.chat('chat', 'two-workers', 'Refine both');
  const state = f.harness.snapshot().states.chat;
  assert.deepEqual(f.steered, ['Refinement 0', 'Refinement 1']);
  assert.equal(new Set(state.steering.map(item => item.workerId)).size, 2);
  assert.equal(new Set(state.steering.map(item => item.jobId)).size, 2);
  assert.ok(state.steering.every(item => item.status === 'accepted'));
  assert.ok(state.tasks.every(item => item.status === 'running'));
  f.release.resolve();
  await operation;
});

test('an unknown steering target is rejected without cancelling the mission or spawning a worker', async t => {
  const f = fixture(t, { followup: async () => ({
    message: 'Route refinement', requests: [{ agentId: 'foreign-worker', prompt: 'Read more' }],
  }) });
  const { operation } = await f.start();
  await f.harness.chat('chat', 'foreign-worker', 'Refine');
  const state = f.harness.snapshot().states.chat;
  assert.equal(f.steered.length, 0);
  assert.equal(state.phase, 'running');
  assert.ok(state.messages.some(message => message.text.includes('No replacement process')));
  f.release.resolve();
  await operation;
  assert.equal(f.calls.filter(req => req.readOnly).length, 1);
});

test('a timed-out steering acknowledgement stays uncertain after a late acknowledgement, with no replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const received = deferred();
  const acknowledgement = deferred();
  const f = fixture(t, { send: async () => { received.resolve(); await acknowledgement.promise; return 'late-provider-id'; } });
  const { operation } = await f.start();
  const followup = f.harness.chat('chat', 'timeout', 'Refine');
  await received.promise;
  t.mock.timers.tick(30000);
  await followup;
  let state = f.harness.snapshot().states.chat;
  assert.equal(state.steering[0].status, 'failed');
  assert.match(state.steering[0].error, /outcome unknown/);
  acknowledgement.resolve();
  await new Promise(resolve => setImmediate(resolve));
  await f.harness.chat('chat', 'timeout', 'Refine');
  state = f.harness.snapshot().states.chat;
  assert.equal(state.steering[0].status, 'failed');
  assert.equal(f.steered.length, 1);
  f.release.resolve();
  await operation;
});

test('brain synthesis waits for the conversational turn, and a finished worker is not restarted for late steering', async t => {
  const entered = deferred();
  const finishReply = deferred();
  let activeBrain = false;
  let synthesized = false;
  const f = fixture(t, {
    followup: async (req, input) => {
      activeBrain = true;
      entered.resolve();
      await finishReply.promise;
      activeBrain = false;
      return { message: 'Relay refinement', requests: [{ agentId: input.resources.agents[0].id, prompt: 'Late refinement' }] };
    },
    synthesize: async () => { assert.equal(activeBrain, false); synthesized = true; },
  });
  const { operation } = await f.start();
  const followup = f.harness.chat('chat', 'late', 'One more thing');
  await entered.promise;
  assert.equal(f.harness.snapshot().states.chat.brainBusy, true);
  f.release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(synthesized, false);
  finishReply.resolve();
  await followup;
  await operation;
  assert.equal(synthesized, true);
  assert.equal(f.steered.length, 0);
  assert.ok(f.harness.snapshot().states.chat.messages.some(message => message.text.includes('Steering not sent')));
  assert.equal(f.calls.filter(req => req.readOnly).length, 1);
});

test('steering failure is explicit and does not cancel the original worker assignment', async t => {
  const f = fixture(t, { sendError: 'CLI rejected steering' });
  const { operation } = await f.start();
  await f.harness.chat('chat', 'follow', 'Refine the task');
  const state = f.harness.snapshot().states.chat;
  assert.equal(state.phase, 'running');
  assert.equal(state.steering[0].status, 'failed');
  assert.match(state.steering[0].error, /CLI rejected/);
  assert.equal(f.calls.find(req => req.readOnly).signal.aborted, false);
  f.release.resolve();
  await operation;
});

test('foreign worker identities and stale control claims cannot receive steering', async t => {
  const f = fixture(t);
  const { operation } = await f.start();
  f.fake.transform = (exchange, item) => item.requestId ? { ...item, claimToken: 'foreign-claim' } : item;
  await f.harness.chat('chat', 'wrong-claim', 'Refine task');
  assert.equal(f.steered.length, 0);
  assert.equal(f.harness.snapshot().states.chat.steering[0].status, 'failed');
  assert.equal(f.harness.snapshot().states.chat.tasks[0].status, 'running');
  f.release.resolve();
  await operation;
});

test('cancellation aborts both the current brain turn and worker without accepting late steering', async t => {
  const entered = deferred();
  const f = fixture(t, { followup: async req => {
    entered.resolve();
    await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
    return { message: 'Late answer', requests: [] };
  } });
  const { operation } = await f.start();
  const followup = f.harness.chat('chat', 'question', 'What is happening');
  await entered.promise;
  f.harness.cancel('chat');
  await Promise.all([followup, operation]);
  const state = f.harness.snapshot().states.chat;
  assert.equal(state.phase, 'idle');
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.messages.some(message => message.text === 'Late answer'), false);
  assert.equal(f.steered.length, 0);
});

test('restart retains accepted receipts and marks uncertain steering failed without replay', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-steering-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'broker.json');
  const broker = new PlexBroker(file);
  broker.enqueue('mission', [{ workerId: 'worker', task: {
    id: 'task', title: 'Task', instructions: 'Read', acceptance: 'Cite', dependsOn: [], agentId: 'worker', memberIndex: null,
  } }]);
  const job = broker.claim('worker', 'mission');
  for (const id of ['accepted', 'uncertain']) {
    broker.requestSteering(id, job.id, id);
    broker.claimSteering(id, job.id, 'worker', job.claimToken);
  }
  broker.finishSteering('accepted', 'provider-message');
  assert.throws(() => broker.claimSteering('accepted', job.id, 'worker', job.claimToken), /refusing automatic replay/);
  const restored = new PlexBroker(file);
  restored.recover();
  assert.deepEqual(restored.steering('mission').map(item => item.status), ['accepted', 'failed']);
  assert.match(restored.steering('mission')[1].error, /unknown.*not replayed/);
});

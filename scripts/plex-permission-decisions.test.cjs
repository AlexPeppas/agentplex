const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { fakeAmqp } = require('./plex-fake-amqp.cjs');
const { PlexBroker } = loadSource('src/main/plex-broker.ts');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, hooks = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-decisions-'));
  const fake = fakeAmqp();
  const { PlexHarness } = loadSource('src/main/plex-harness.ts', { amqplib: fake.amqp });
  const ready = deferred();
  const release = deferred();
  const decisions = [];
  let launches = 0;
  let workerSignal;
  const harness = new PlexHarness(home, async req => {
    if (req.schema.properties.tasks) return { message: 'Read fixture', squadId: null, tasks: [{
      id: 'read', title: 'Read', instructions: 'Read fixture', acceptance: 'Report', dependsOn: [],
      agentId: JSON.parse(req.prompt).resources.agents[0].id, memberIndex: null,
    }] };
    if (req.readOnly) {
      launches++;
      workerSignal = req.signal;
      req.registerPermissionResponder(async (id, decision) => {
        decisions.push({ id, decision });
        if (hooks.respond) await hooks.respond(req.signal);
        await req.onPermission({ requestId: id, status: 'completed' });
      });
      await req.onPermission({ requestId: 'permission', status: 'requested', kind: 'read', resource: 'synthetic.txt' });
      ready.resolve();
      await Promise.race([release.promise, new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }))]);
      req.registerPermissionResponder(null);
    }
    return { status: 'completed', summary: 'Done', evidence: [], limitations: [] };
  }, () => {});
  harness.saveBlueprint({ id: 'squad', name: 'Squad', revision: 1, agents: [{
    id: 'reader', name: 'Reader', description: 'Reads fixture', instructions: '', tools: ['view'],
  }] });
  harness.createConversation(home, 'squad', 'chat');
  harness.createConversation(home, 'squad', 'other-chat');
  await harness.chat('chat', 'initial', 'Read');
  const mission = harness.approve('chat', harness.snapshot().states.chat.approvalId);
  await ready.promise;
  const state = () => harness.snapshot().states.chat;
  const jobId = state().tasks[0].jobId;
  t.after(async () => {
    harness.dispose();
    release.resolve();
    await mission;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { home, fake, harness, decisions, mission, release, state, jobId,
    launches: () => launches, signal: () => workerSignal,
    decide: decision => harness.decidePermission('chat', jobId, 'permission', decision) };
}

for (const decision of ['approve-once', 'reject']) {
  test(`${decision} traverses the control queue, persists its receipt and does not cancel or replace the worker`, async t => {
    const f = await fixture(t);
    assert.equal(f.state().phase, 'waiting-for-approval');
    await f.decide(decision);
    assert.deepEqual(f.decisions, [{ id: 'permission', decision }]);
    assert.equal(f.state().tasks[0].permissions[0].decision.status, 'accepted');
    assert.equal(f.state().tasks[0].permissions[0].status, 'resolved');
    assert.equal(f.state().phase, 'running');
    assert.equal(f.signal().aborted, false);
    assert.equal(f.launches(), 1);
    const control = f.fake.publications.find(item => item.payload.controlType === 'permission');
    assert.ok(control.key.endsWith('.control'));
    assert.equal(control.payload.jobId, f.jobId);
    assert.equal(control.payload.permissionRequestId, 'permission');
    await assert.rejects(f.decide(decision), /stale|already attempted/);
    f.release.resolve();
    await f.mission;
    const broker = new PlexBroker(path.join(f.home, 'chats', 'chat', 'broker.json'));
    assert.equal(broker.jobs(f.state().missionId)[0].permissions[0].decision.status, 'accepted');
  });
}

test('foreign conversations, assignments, permission IDs and invalid decisions never reach the worker', async t => {
  const f = await fixture(t);
  for (const args of [
    ['other-chat', f.jobId, 'permission', 'approve-once'],
    ['chat', 'wrong-job', 'permission', 'approve-once'],
    ['chat', f.jobId, 'foreign-request', 'approve-once'],
    ['chat', f.jobId, 'permission', 'approve-always'],
  ]) await assert.rejects(f.harness.decidePermission(...args));
  assert.equal(f.decisions.length, 0);
  await f.decide('reject');
  f.release.resolve();
  await f.mission;
});

test('a forged control claim cannot approve a permission and its receipt is explicitly failed', async t => {
  const f = await fixture(t);
  f.fake.transform = (exchange, item) => item.controlType === 'permission' ? { ...item, claimToken: 'foreign' } : item;
  await assert.rejects(f.decide('approve-once'));
  assert.equal(f.decisions.length, 0);
  assert.equal(f.state().tasks[0].permissions[0].decision.status, 'failed');
  assert.equal(f.state().phase, 'waiting-for-approval');
  f.harness.cancel('chat');
  await f.mission;
});

test('a failed provider response is visible and never automatically retried', async t => {
  const f = await fixture(t, { respond: async () => { throw new Error('Provider decision RPC failed'); } });
  await assert.rejects(f.decide('approve-once'), /RPC failed/);
  await assert.rejects(f.decide('approve-once'), /already attempted/);
  assert.match(f.state().tasks[0].permissions[0].decision.error, /RPC failed/);
  assert.equal(f.decisions.length, 1);
  assert.equal(f.signal().aborted, false);
  f.harness.cancel('chat');
  await f.mission;
});

test('cancellation during a decision interrupts the worker and cannot reopen its card', async t => {
  const entered = deferred();
  const f = await fixture(t, { respond: async signal => {
    entered.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    throw new Error('Worker cancelled');
  } });
  const failed = assert.rejects(f.decide('approve-once'), /cancelled|stopped/);
  await entered.promise;
  f.harness.cancel('chat');
  await failed;
  await f.mission;
  assert.equal(f.state().tasks[0].permissions[0].status, 'interrupted');
  assert.equal(f.state().tasks[0].permissions[0].decision.status, 'failed');
  assert.equal(f.state().phase, 'idle');
});

test('a late RPC acknowledgement cannot overwrite a timed-out receipt or trigger replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = deferred();
  const ack = deferred();
  const f = await fixture(t, { respond: async () => { entered.resolve(); await ack.promise; } });
  const failed = assert.rejects(f.decide('approve-once'), /uncertain/);
  await entered.promise;
  t.mock.timers.tick(30000);
  await failed;
  assert.equal(f.state().tasks[0].permissions[0].decision.status, 'failed');
  ack.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state().tasks[0].permissions[0].decision.status, 'failed');
  await assert.rejects(f.decide('approve-once'), /stale|already attempted/);
  f.release.resolve();
  await f.mission;
});

test('restart marks an in-flight permission decision uncertain and does not replay it', async t => {
  const f = await fixture(t);
  const file = path.join(f.home, 'chats', 'chat', 'broker.json');
  const broker = new PlexBroker(file);
  const job = broker.jobs(f.state().missionId)[0];
  broker.requestPermissionDecision(job, 'permission', 'approve-once');
  broker.claimPermissionDecision(job.id, job.workerId, job.claimToken, 'permission');
  const restored = new PlexBroker(file);
  restored.recover();
  const permission = restored.jobs(job.missionId)[0].permissions[0];
  assert.equal(permission.status, 'interrupted');
  assert.equal(permission.decision.status, 'failed');
  assert.match(permission.decision.error, /unknown.*not replayed/);
  assert.equal(f.decisions.length, 0);
});

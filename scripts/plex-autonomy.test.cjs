const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { fakeAmqp } = require('./plex-fake-amqp.cjs');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const continuation = (tasks = [], scope = 'within-goal') => ({ scope, reason: 'Within the approved synthetic goal', tasks });
const task = (id, agentId, dependsOn = []) => ({
  id, agentId, title: id, instructions: 'Review synthetic fixture', acceptance: 'Report result', memberIndex: null, dependsOn,
});
const result = { status: 'completed', summary: 'Done', evidence: [], limitations: [] };
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Condition not reached');
};
function fixture(t, hooks = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-autonomy-'));
  const fake = fakeAmqp();
  const { PlexHarness } = loadSource('src/main/plex-harness.ts', { amqplib: fake.amqp });
  const workers = [];
  const questions = [];
  let brainCalls = 0;
  let brainActive = 0;
  let mission;
  const service = new PlexHarness(home, async req => {
    const input = JSON.parse(req.prompt);
    if (req.readOnly) {
      workers.push(req);
      if (hooks.worker) await hooks.worker(req, input, workers.length);
      return result;
    }
    assert.equal(brainActive++, 0, 'Brain turns must never overlap');
    try {
      if (req.schema.properties.tasks) return { message: 'Approved goal', squadId: null,
        tasks: input.resources.agents.slice(0, hooks.initialWorkers ?? 1).map((agent, i) => task(`initial-${i}`, agent.id)) };
      if (req.schema.properties.questionDecision) {
        questions.push(input);
        return hooks.answer ? await hooks.answer(req, input) :
          { questionDecision: 'answer', answer: 'Use the existing convention', reason: 'Known from approved context', continuation: continuation() };
      }
      if (req.schema.properties.requests) {
        return hooks.followup ? await hooks.followup(req, input) : { message: 'Still working', requests: [], continuation: continuation() };
      }
      brainCalls++;
      return hooks.synthesize ? await hooks.synthesize(req, input, brainCalls) : { ...result, continuation: continuation() };
    } finally { brainActive--; }
  }, () => {});
  service.saveBlueprint({ id: 'squad', name: 'Squad', revision: 1, agents: [0, 1].map(i => ({
    id: `worker-${i}`, name: `Reader ${i}`, description: 'Review', tools: ['view'], instructions: '',
  })) });
  service.createConversation(home, 'squad', 'chat');
  service.createConversation(home, 'squad', 'other');
  t.after(async () => {
    service.dispose();
    if (mission) await mission;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const state = () => service.snapshot().states.chat;
  const start = async () => {
    await service.chat('chat', 'initial-message', 'Review the fixture');
    mission = service.approve('chat', state().approvalId);
    return { mission };
  };
  return { service, state, start, workers, questions, fake, home };
}

test('routine questions are answered by Plex in the same worker and not copied into the main chat', async t => {
  let answer;
  const f = fixture(t, { worker: async req => {
    answer = await req.onQuestion({ question: 'Which convention should I use?' }, req.signal);
  } });
  const { mission } = await f.start();
  await mission;
  assert.equal(answer.answer, 'Use the existing convention');
  assert.equal(f.workers.length, 1);
  assert.equal(f.state().questions[0].answeredBy, 'plex');
  assert.equal(f.state().messages.some(item => item.text.includes('Which convention')), false);
  assert.equal(f.state().phase, 'idle');
});

test('ambiguous or sensitive input escalates only to the originating chat, rejects foreign/stale answers', async t => {
  let answer;
  const f = fixture(t, {
    worker: async req => { answer = await req.onQuestion({ question: 'Which environment?', choices: ['staging', 'prod'], allowFreeform: false }, req.signal); },
    answer: async () => ({ questionDecision: 'human', answer: '', reason: 'Deployment target is not authorized', continuation: continuation([], 'needs-human') }),
  });
  const { mission } = await f.start();
  await waitFor(() => f.state().questions?.[0]?.status === 'human');
  const question = f.state().questions[0];
  assert.equal(f.state().phase, 'waiting-for-approval');
  await assert.rejects(f.service.answerQuestion('other', question.id, 'staging'), /stale/);
  await assert.rejects(f.service.answerQuestion('chat', question.id, 'unknown'), /choices/);
  await f.service.answerQuestion('chat', question.id, 'staging');
  await assert.rejects(f.service.answerQuestion('chat', question.id, 'prod'), /stale/);
  await mission;
  assert.deepEqual(answer, { answer: 'staging', wasFreeform: false });
  assert.equal(f.state().questions[0].answeredBy, 'user');
});

test('Plex can queue an independent squad helper in response to a worker question', async t => {
  const f = fixture(t, {
    worker: async (req, input, n) => {
      if (n === 1) await req.onQuestion({ question: 'Can another squad member review the edge case?' }, req.signal);
    },
    answer: async (req, input) => ({
      questionDecision: 'answer', answer: 'A helper review is queued; continue your own work.',
      reason: 'Independent review is within goal',
      continuation: continuation([task('helper', input.resources.agents[1].id)]),
    }),
  });
  const { mission } = await f.start();
  await mission;
  assert.equal(f.workers.length, 2);
  assert.ok(f.state().tasks.every(item => item.status === 'completed'));
  assert.equal(f.fake.publications.filter(item => item.exchange.endsWith('.asks')).length, 2);
});

test('Plex reviews results and dispatches follow-on work with existing dependencies without another approval', async t => {
  const f = fixture(t, { synthesize: async (req, input, round) => ({
    ...result, continuation: continuation(round === 1 ? [
      task('follow-on', input.tasks[0].assignedAgentId, [input.tasks[0].id]),
    ] : []),
  }) });
  const { mission } = await f.start();
  await mission;
  assert.equal(f.state().phase, 'idle');
  assert.equal(f.workers.length, 2);
  assert.equal(f.state().tasks.length, 2);
  assert.equal(f.state().tasks[1].status, 'completed');
  assert.equal(f.workers[0].conversationHome, f.workers[1].conversationHome);
  assert.equal(f.workers[0].cwd, f.workers[1].cwd);
  assert.equal(f.state().messages.filter(item => item.text.startsWith('Plan approved')).length, 1);
});

test('scope escalation at result review does not dispatch any new assignment', async t => {
  const f = fixture(t, { synthesize: async () => ({ ...result, continuation: continuation([], 'needs-human') }) });
  const { mission } = await f.start();
  await mission;
  assert.equal(f.workers.length, 1);
  assert.ok(f.state().messages.some(item => item.text.includes('Human input required')));
});

test('two simultaneous worker questions and a user follow-up serialize through one brain', async t => {
  const release = deferred();
  const f = fixture(t, {
    initialWorkers: 2,
    worker: async req => { await req.onQuestion({ question: 'Which convention?' }, req.signal); },
    answer: async req => {
      await Promise.race([release.promise, new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }))]);
      return { questionDecision: 'answer', answer: 'Existing', reason: 'Known', continuation: continuation() };
    },
  });
  const { mission } = await f.start();
  await waitFor(() => f.state().questions?.length === 2);
  assert.equal(f.questions.length, 1);
  release.resolve();
  await mission;
  assert.equal(f.questions.length, 2);
  assert.ok(f.state().questions.every(item => item.status === 'answered'));
});

test('cancelling a pending human question stops waiting and rejects late answers', async t => {
  const f = fixture(t, {
    worker: async req => { await req.onQuestion({ question: 'Choose a goal' }, req.signal); },
    answer: async () => ({ questionDecision: 'human', answer: '', reason: 'Unclear', continuation: continuation([], 'needs-human') }),
  });
  const { mission } = await f.start();
  await waitFor(() => f.state().questions?.[0]?.status === 'human');
  const id = f.state().questions[0].id;
  f.service.cancel('chat');
  await mission;
  assert.equal(f.state().questions[0].status, 'interrupted');
  await assert.rejects(f.service.answerQuestion('chat', id, 'Late'), /stale/);
  assert.equal(f.state().phase, 'idle');
});

test('a human-required decision cannot smuggle assignments into the mission', async t => {
  const f = fixture(t, { synthesize: async (req, input) => ({
    ...result, continuation: continuation([task('bad', input.tasks[0].assignedAgentId)], 'needs-human'),
  }) });
  const { mission } = await f.start();
  await mission;
  assert.equal(f.workers.length, 1);
  assert.equal(f.state().phase, 'error');
  assert.match(f.state().error, /cannot be dispatched/);
});

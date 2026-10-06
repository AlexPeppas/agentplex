const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { loadSource } = require('./test-support.cjs');
const amqp = require('./plex-fake-amqp.cjs').fakeAmqp();
const { PlexCoordinator, validatePlexPlan, PLEX_PLAN_SCHEMA } = loadSource('src/main/plex-coordinator.ts', { amqplib: amqp.amqp });

const result = summary => ({ status: 'completed', summary, evidence: ['sample.txt:1 contains the example'], limitations: ['No tests or edits performed'] });
const spec = (id, memberIndex = 0, dependsOn = []) => ({
  id, title: id, instructions: `Read evidence for ${id}`, acceptance: 'Return cited findings', dependsOn, agentId: null, memberIndex,
});
const plan = tasks => ({ message: 'Review with the squad', squadId: 'saved', tasks });
function fixture(t, runner) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-poc-test-'));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(path.join(root, 'sample.txt'), 'Synthetic public test fixture');
  const squads = [{ id: 'saved', name: 'Reviewers', sessions: [
    { name: 'Reviewer A', cwd: root, cli: 'copilot', sessionId: 'must-not-resume' },
    { name: 'Reviewer B', cwd: root, cli: 'copilot' },
  ], createdAt: new Date().toISOString() }];
  const changes = [];
  const service = new PlexCoordinator(file, runner, () => squads, state => changes.push(state));
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, file, squads, changes, service };
}

test('approval gates squad spawning; dependencies and results persist; existing workers are reusable', async t => {
  let reuse = null;
  const calls = [];
  const f = fixture(t, async req => {
    calls.push(req);
    if (req.schema === PLEX_PLAN_SCHEMA) return reuse
      ? { message: 'Reuse', squadId: null, tasks: [{ ...spec('again'), memberIndex: null, agentId: reuse }] }
      : plan([spec('api'), spec('ui', 1), spec('integration', 0, ['api', 'ui'])]);
    const input = JSON.parse(req.prompt);
    if (req.readOnly) {
      if (input.taskId === 'integration') assert.equal(input.prerequisites.length, 2);
      return result(`Result: ${input.taskId}`);
    }
    return result('Mission synthesis');
  });
  f.service.start();
  f.squads[0].sessions[0].name = 'dev-arch';
  f.squads[0].sessions[0].description = 'Architecture and component boundaries';
  let state = await f.service.chat('Review fixture');
  const resources = JSON.parse(calls[0].prompt).resources;
  assert.equal(resources.squads[0].sessions[0].description, 'Architecture and component boundaries');
  assert.deepEqual(resources.squads[0].sessions[0].availableTools, ['view', 'glob', 'rg']);
  assert.equal(state.phase, 'awaiting-approval');
  assert.equal(state.agents.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(state.proposedSquad.name, 'Reviewers');
  await assert.rejects(f.service.chat('Duplicate'), /Approve or cancel/);
  state = await f.service.approve();
  assert.equal(state.phase, 'idle');
  assert.equal(state.agents.length, 2);
  const registered = f.service.listResources().agents[0];
  assert.equal(registered.name, 'dev-arch');
  assert.equal(registered.description, 'Architecture and component boundaries');
  assert.match(registered.queue, /^plex\..*\.worker\./);
  assert.ok(amqp.publications.some(item => item.key === registered.queue));
  assert.deepEqual(state.tasks.map(task => task.status), ['completed', 'completed', 'completed']);
  assert.equal(state.messages.at(-1).role, 'plex');
  assert.match(state.messages.at(-1).text, /Mission synthesis/);
  assert.equal(calls.filter(call => call.readOnly).length, 3);
  assert.ok(calls.every(call => !call.prompt.includes('must-not-resume') || !call.readOnly));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), state);
  await assert.rejects(f.service.approve(), /No plan/);
  reuse = state.agents[0].id;
  await f.service.chat('Use existing reviewer');
  state = await f.service.approve();
  assert.equal(state.agents.length, 2);
  assert.equal(state.tasks[0].assignedAgentId, reuse);
  const workerCalls = calls.filter(call => call.readOnly);
  assert.equal(workerCalls[0].conversationHome, workerCalls[2].conversationHome);
  assert.equal(workerCalls[0].conversationHome, workerCalls[3].conversationHome);
  assert.notEqual(workerCalls[0].conversationHome, workerCalls[1].conversationHome);
  const publisherHome = calls[0].conversationHome;
  assert.ok(publisherHome);
  assert.ok(calls.filter(call => !call.readOnly).every(call => call.conversationHome === publisherHome));
  assert.ok(workerCalls.every(call => call.conversationHome !== publisherHome));
  f.service.dispose();
  const restored = new PlexCoordinator(f.file, async req => {
    assert.equal(req.conversationHome, req.readOnly ? workerCalls[0].conversationHome : publisherHome);
    return req.schema === PLEX_PLAN_SCHEMA
      ? { message: 'Resume reviewer', squadId: null, tasks: [{ ...spec('restored'), memberIndex: null, agentId: reuse }] }
      : result('Continued after restart');
  }, () => f.squads, () => {});
  await restored.chat('Continue');
  assert.equal((await restored.approve()).phase, 'idle');
  restored.dispose();
  assert.ok(f.changes.some(state => state.phase === 'summarizing'));
});

test('ineligible squads are excluded and failed plans are explicitly corrected on the next turn', async t => {
  let calls = 0;
  const f = fixture(t, async req => {
    calls++;
    const input = JSON.parse(req.prompt);
    assert.deepEqual(input.resources.squads, []);
    if (calls === 1) return plan([spec('bad')]);
    assert.equal(input.approvalState.awaitingApproval, false);
    assert.equal(input.approvalState.plan, null);
    assert.match(input.approvalState.previousError, /unknown squad/);
    assert.ok(input.conversation.some(message => message.role === 'system' && /No plan is awaiting approval/.test(message.text)));
    return { message: 'Create a compatible Copilot squad first.', tasks: [], squadId: null };
  });
  f.squads[0].sessions[0].cli = 'claude';
  f.service.start();
  const failed = await f.service.chat('Review');
  assert.equal(failed.phase, 'error');
  assert.equal(failed.plan, null);
  await assert.rejects(f.service.approve(), /No plan/);
  const next = await f.service.chat("it's approved");
  assert.equal(next.phase, 'idle');
  assert.equal(next.agents.length, 0);
  assert.equal(next.missionId, null);
  assert.equal(calls, 2);
});

test('rejecting a valid plan never publishes jobs and permits a revised request', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return plan([spec('a')]); });
  f.service.start();
  await f.service.chat('Review');
  const rejected = f.service.cancel();
  assert.equal(rejected.phase, 'idle');
  assert.equal(rejected.plan, null);
  assert.equal(rejected.missionId, null);
  assert.equal(rejected.agents.length, 0);
  assert.match(rejected.messages.at(-1).text, /Plan rejected/);
  await assert.rejects(f.service.approve(), /No plan/);
  assert.equal((await f.service.chat('Revised review')).phase, 'awaiting-approval');
  assert.equal(calls, 2);
});

test('approval-like model prose without tasks cannot imply an executable plan or hide host state', async t => {
  const f = fixture(t, async () => ({ message: 'Please review and approve the plan to dispatch.', tasks: [], squadId: null }));
  f.service.start();
  const state = await f.service.chat('Review');
  assert.equal(state.phase, 'idle');
  assert.equal(state.plan, null);
  assert.equal(state.approvalId, null);
  assert.match(state.messages.at(-1).text, /No executable plan.*Nothing is awaiting approval/);
  await assert.rejects(f.service.approve(), /No plan/);
});

test('persistent CLI conversations resume exact IDs, reject overlapping turns and never replace missing history', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-conversations-test-'));
  const previous = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'synthetic-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const launches = [];
  const { runPlexCli } = loadSource('src/main/plex-cli.ts', {
    'node:child_process': { spawn: (command, args, options) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.kill = () => {};
      launches.push({ args, options, child });
      return child;
    } },
  });
  const request = { prompt: 'Synthetic', cwd: root, schema: {}, readOnly: true,
    signal: new AbortController().signal, conversationHome: path.join(root, 'worker-a') };
  const finish = async (promise, launch) => {
    const { id } = JSON.parse(fs.readFileSync(path.join(launch.options.env.COPILOT_HOME, 'plex-conversation.json'), 'utf8'));
    const history = path.join(launch.options.env.COPILOT_HOME, 'session-state', id);
    fs.mkdirSync(history, { recursive: true });
    fs.writeFileSync(path.join(history, 'events.jsonl'), '{}\n');
    launch.child.stdout.emit('data', JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(result('Done')) } }) + '\n' +
      JSON.stringify({ type: 'result', exitCode: 0 }));
    launch.child.emit('close', 0);
    await promise;
    return id;
  };
  const first = runPlexCli(request);
  await Promise.resolve();
  assert.ok(launches[0].args.includes('--session-id'));
  assert.equal(launches[0].options.cwd, root);
  await assert.rejects(runPlexCli(request), /active turn/);
  const id = await finish(first, launches[0]);
  const second = runPlexCli(request);
  await Promise.resolve();
  assert.deepEqual(launches[1].args.slice(0, 2), ['--resume', id]);
  assert.equal(launches[1].options.cwd, root);
  assert.equal(await finish(second, launches[1]), id);
  const separate = runPlexCli({ ...request, conversationHome: path.join(root, 'worker-b') });
  await Promise.resolve();
  assert.notEqual(await finish(separate, launches[2]), id);
  await assert.rejects(runPlexCli({ ...request, readOnly: false }), /mismatched/);
  await assert.rejects(runPlexCli({ ...request, cwd: path.join(root, 'another-workspace') }), /mismatched/);
  fs.unlinkSync(path.join(request.conversationHome, 'session-state', id, 'events.jsonl'));
  await assert.rejects(runPlexCli(request), /history is missing/);
  assert.equal(launches.length, 3);
});

test('rejects unknown targets, duplicate IDs, cycles, unsupported squads, and excessive fanout', t => {
  const f = fixture(t, async () => result('unused'));
  assert.throws(() => validatePlexPlan(plan([spec('a'), spec('a')]), [], f.squads), /Duplicate/);
  assert.throws(() => validatePlexPlan(plan([spec('a', 0, ['b']), spec('b', 1, ['a'])]), [], f.squads), /cyclic/);
  assert.throws(() => validatePlexPlan(plan([spec('a', 0, ['missing'])]), [], f.squads), /dependency/);
  assert.throws(() => validatePlexPlan(plan([spec('a', 9)]), [], f.squads), /Task needs/);
  assert.throws(() => validatePlexPlan(plan([{ ...spec('a'), agentId: 'foreign-pty', memberIndex: null }]), [], f.squads), /Unknown/);
  assert.throws(() => validatePlexPlan(plan(Array.from({ length: 7 }, (_, i) => spec(`t${i}`))), [], f.squads), /six/);
  f.squads[0].sessions[1].cli = 'claude';
  assert.throws(() => validatePlexPlan(plan([spec('a')]), [], f.squads), /1-4 Copilot/);
});

test('worker failure blocks dependents, while unrelated work is collected and synthesized', async t => {
  const f = fixture(t, async req => {
    if (req.schema === PLEX_PLAN_SCHEMA) return plan([spec('bad'), spec('good', 1), spec('dependent', 0, ['bad'])]);
    if (req.readOnly && JSON.parse(req.prompt).taskId === 'bad') throw new Error('Provider unavailable');
    if (!req.readOnly) assert.deepEqual(JSON.parse(req.prompt).tasks.map(task => task.status), ['blocked', 'completed', 'blocked']);
    return result('Partial outcome');
  });
  f.service.start();
  await f.service.chat('Review');
  const state = await f.service.approve();
  assert.deepEqual(state.tasks.map(task => task.status), ['blocked', 'completed', 'blocked']);
  assert.match(state.tasks[0].error, /Provider unavailable/);
});

test('same worker is never used concurrently; maximum concurrency is two', async t => {
  let running = 0;
  let high = 0;
  const active = new Set();
  const f = fixture(t, async req => {
    if (req.schema === PLEX_PLAN_SCHEMA) return plan([spec('a'), spec('b'), spec('c', 1), spec('d', 1)]);
    if (req.readOnly) {
      const role = JSON.parse(req.prompt).role;
      assert.ok(!active.has(role));
      active.add(role);
      high = Math.max(high, ++running);
      await new Promise(resolve => setTimeout(resolve, 5));
      active.delete(role);
      running--;
    }
    return result('Done');
  });
  f.service.start();
  await f.service.chat('Review');
  await f.service.approve();
  assert.equal(high, 2);
});

test('cancel aborts in-flight calls, keeps tasks blocked and prevents stale results or automatic retries', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const f = fixture(t, async req => {
    if (req.schema === PLEX_PLAN_SCHEMA) return plan([spec('a')]);
    began();
    await new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }));
    return result('Late result');
  });
  f.service.start();
  await f.service.chat('Review');
  const execution = f.service.approve();
  await started;
  f.service.cancel();
  const state = await execution;
  assert.equal(state.phase, 'idle');
  assert.equal(state.tasks[0].status, 'blocked');
  assert.equal(state.tasks[0].result.summary, 'Cancelled by user');
  assert.equal(state.agents[0].status, 'idle');
});

test('restart never replays an approved/running request; approval snapshots cannot silently change', async t => {
  const f = fixture(t, async req => req.schema === PLEX_PLAN_SCHEMA ? plan([spec('a')]) : result('done'));
  f.service.start();
  await f.service.chat('Review');
  f.squads[0].sessions[0].cwd = path.join(f.root, 'missing-new-location');
  await f.service.approve();
  assert.equal(f.service.snapshot().agents[0].cwd, f.root);
  const state = f.service.snapshot();
  state.phase = 'running';
  state.tasks[0].status = 'running';
  fs.writeFileSync(f.file, JSON.stringify(state));
  let called = false;
  const restored = new PlexCoordinator(f.file, async () => { called = true; }, () => f.squads, () => {});
  assert.equal(restored.snapshot().phase, 'interrupted');
  assert.equal(restored.snapshot().tasks[0].status, 'completed', 'broker, not a stale UI snapshot, owns completed results');
  assert.equal(called, false);
  await assert.rejects(restored.approve(), /No plan/);
});

test('missing workspace prevents any worker launch', async t => {
  const f = fixture(t, async req => req.schema === PLEX_PLAN_SCHEMA ? plan([spec('a')]) : { summary: '' });
  f.squads[0].sessions[0].cwd = path.join(f.root, 'missing');
  f.service.start();
  await f.service.chat('Review');
  await assert.rejects(f.service.approve(), /ENOENT/);
  assert.equal(f.service.snapshot().agents.length, 0);
});

test('malformed worker results cannot become completed tasks', async t => {
  const f = fixture(t, async req => {
    if (req.schema === PLEX_PLAN_SCHEMA) return plan([spec('a')]);
    return req.readOnly ? { summary: '', evidence: [], limitations: [] } : result('Worker failed');
  });
  f.service.start();
  await f.service.chat('Review');
  const state = await f.service.approve();
  assert.equal(state.tasks[0].status, 'blocked');
  assert.match(state.tasks[0].error, /Invalid/);
  assert.equal(state.tasks[0].result.status, 'blocked');
});

test('malformed persisted state is rejected rather than overwritten or automatically dispatched', t => {
  const f = fixture(t, async () => result('unused'));
  fs.writeFileSync(f.file, '{"version":1,"enabled":true,"phase":"running","messages":[{}],"agents":[],"tasks":[]}');
  const original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => new PlexCoordinator(f.file, async () => {}, () => f.squads, () => {}), /Invalid/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('legacy Claude POC is archived, not relabeled as Copilot workers', t => {
  const f = fixture(t, async () => result('unused'));
  const old = {
    version: 1, enabled: true, phase: 'idle', messages: [{ role: 'plex', text: 'Previous Claude conversation' }],
    agents: [{ id: 'old', name: 'Claude', cwd: f.root, squadId: 's', squadName: 'old', status: 'idle' }],
    tasks: [], plan: null, proposedSquad: null, error: null,
  };
  fs.writeFileSync(f.file, JSON.stringify(old));
  const migrated = new PlexCoordinator(f.file, async () => {}, () => f.squads, () => {});
  assert.equal(migrated.snapshot().version, 2);
  assert.deepEqual(migrated.snapshot().agents, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${f.file}.v1-backup`, 'utf8')), old);
  assert.match(migrated.snapshot().messages.at(-1).text, /Copilot-only/);
});

test('coordinator can query authoritative queue status while a worker is still running', async t => {
  let release;
  let began;
  const running = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async req => {
    if (req.schema === PLEX_PLAN_SCHEMA) return plan([spec('a')]);
    if (req.readOnly) { began(); await gate; }
    return result('Done');
  });
  f.service.start();
  await f.service.chat('Review');
  const mission = f.service.approve();
  await running;
  const status = f.service.getTaskStatus();
  assert.equal(status[0].status, 'running');
  assert.ok(status[0].jobId);
  assert.equal(status[0].resultId, undefined);
  release();
  const completed = await mission;
  assert.equal(completed.tasks[0].status, 'completed');
  assert.ok(completed.tasks[0].resultId);
});

test('CLI adapter restricts tools, isolates config, never invokes a shell, and parses Copilot JSONL', async t => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  let sent;
  child.stdin.end = value => { sent = value; };
  child.kill = () => {};
  let spawnArgs;
  let isolatedHome;
  const priorToken = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'synthetic-test-token';
  t.after(() => {
    if (priorToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = priorToken;
  });
  const { runPlexCli } = loadSource('src/main/plex-cli.ts', {
    'node:child_process': { spawn: (...args) => { spawnArgs = args; isolatedHome = args[2].env.COPILOT_HOME; return child; } },
  });
  const controller = new AbortController();
  const response = runPlexCli({ prompt: 'Synthetic test only', cwd: process.cwd(), schema: {}, readOnly: true, signal: controller.signal });
  await Promise.resolve();
  assert.equal(spawnArgs[2].shell, false);
  assert.match(sent, /Synthetic test only/);
  assert.match(spawnArgs[0], /copilot/);
  const args = spawnArgs[1];
  assert.ok(args.includes('--available-tools=view,glob,rg'));
  assert.ok(args.includes('--deny-tool=shell'));
  assert.ok(args.includes('--deny-tool=write'));
  assert.ok(args.includes('--disable-builtin-mcps'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(isolatedHome, 'config.json'), 'utf8')).disableAllHooks, true);
  assert.ok(!args.some(arg => arg.includes('allow-all')));
  child.stdout.emit('data', JSON.stringify({ type: 'assistant.message', data: { content: JSON.stringify(result('Done')), toolRequests: [] } }) + '\n');
  child.stdout.emit('data', JSON.stringify({ type: 'result', exitCode: 0 }));
  child.emit('close', 0);
  assert.deepEqual(await response, result('Done'));
  assert.equal(fs.existsSync(isolatedHome), false);
});

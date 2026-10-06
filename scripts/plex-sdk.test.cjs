const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');
const cli = loadSource('src/main/plex-cli.ts');
const { preauthorizedPermission } = loadSource('src/main/plex-sdk.ts');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-sdk-test-'));
  const launches = [];
  const events = [];
  const permissions = [];
  const controller = new AbortController();
  let send;
  let respond;
  const { runPlexSteerableCli } = loadSource('src/main/plex-sdk.ts', {
    './plex-cli': { ...cli, githubToken: async () => 'synthetic', copilotCommand: () => 'copilot' },
    '@github/copilot-sdk': {
      RuntimeConnection: { forStdio: options => options },
      CopilotClient: class {
        constructor(options) { this.options = options; launches.push(this); this.handlers = []; }
        async start() {}
        async stop() { this.stopped = true; return []; }
        async forceStop() { this.stopped = true; }
        async createSession(config) { return this.session(config.sessionId, config, false); }
        async resumeSession(id, config) { return this.session(id, config, true); }
        session(id, config, resumed) {
          this.config = config; this.resumed = resumed; this.id = id;
          this.emit = event => this.handlers.forEach(handler => handler(event));
          this.finish = (summary = 'done') => {
            this.emit({ type: 'assistant.message', data: { messageId: 'answer', content: JSON.stringify({
              status: 'completed', summary, evidence: [], limitations: [],
            }) } });
            this.emit({ type: 'session.idle', data: {} });
          };
          const file = path.join(home, 'session-state', id, 'events.jsonl');
          this.file = file;
          fs.mkdirSync(path.dirname(file), { recursive: true });
          if (!fs.existsSync(file)) fs.writeFileSync(file, '');
          return {
            on: callback => { this.handlers.push(callback); },
            rpc: { options: { update: async params => { this.updatedOptions = params; return { success: true }; } },
              permissions: { handlePendingPermissionRequest: async params => {
              this.decisions ??= [];
              this.decisions.push(params);
              if (this.decide) return this.decide(params);
              this.emit({ type: 'permission.completed', data: { requestId: params.requestId } });
              return { success: true };
            } } },
            send: async options => {
              const messageId = options.mode ? 'provider-message' : 'initial-message';
              if (options.mode) {
                this.steering ??= [];
                this.steering.push(options);
                if (this.delayedSteering) return this.delayedSteering();
              } else this.initial = options;
              this.emit({ type: 'user.message', data: { messageId, content: options.prompt } });
              return messageId;
            },
          };
        }
      },
    },
  });
  const req = { prompt: 'Read sample', cwd: home, conversationHome: home, schema: {}, readOnly: true,
    signal: controller.signal, tools: ['view'], model: 'synthetic-model',
    registerSteering: value => { send = value; },
    registerPermissionResponder: value => { respond = value; },
    onPermission: async event => { permissions.push(event); },
    onActivity: async batch => { events.push(...batch); } };
  t.after(() => { controller.abort(); fs.rmSync(home, { recursive: true, force: true }); });
  const ready = async () => { for (let i = 0; i < 30 && !send; i++) await Promise.resolve(); assert.ok(send); };
  return { run: patch => runPlexSteerableCli({ ...req, ...patch }), ready, launches, controller,
    steer: text => send(text), events, currentSend: () => send,
    respond: (id, decision) => respond(id, decision), currentResponder: () => respond, permissions };
}

test('SDK worker steering preserves session, cwd, model, tool allowlist and does not enqueue a second assignment', async t => {
  const f = fixture(t);
  const run = f.run();
  await f.ready();
  const runtime = f.launches[0];
  assert.deepEqual(runtime.config.availableTools, ['view']);
  assert.equal(runtime.config.model, 'synthetic-model');
  assert.equal(runtime.config.workingDirectory, runtime.options.workingDirectory);
  assert.equal(runtime.config.remoteSession, 'off');
  assert.equal(await f.steer('Refine the review'), 'provider-message');
  assert.deepEqual(runtime.steering, [{ prompt: 'Refine the review', mode: 'immediate' }]);
  assert.equal(f.launches.length, 1);
  runtime.finish();
  assert.equal((await run).status, 'completed');
  assert.equal(f.currentSend(), null);
  assert.equal(runtime.stopped, true);
  const resumed = f.run();
  await f.ready();
  assert.equal(f.launches[1].resumed, true);
  assert.equal(f.launches[1].id, runtime.id);
  assert.deepEqual(f.launches[1].updatedOptions, { sessionLimits: null });
  assert.equal(runtime.options.connection.args.includes('--max-ai-credits'), false);
  f.launches[1].finish();
  await resumed;
  await assert.rejects(f.run({ model: 'changed' }), /mismatched/);
});

test('worker cancellation unregisters steering and stops only its SDK runtime', async t => {
  const f = fixture(t);
  const run = f.run();
  const rejected = assert.rejects(run, /cancelled/);
  await f.ready();
  f.controller.abort();
  await rejected;
  assert.equal(f.currentSend(), null);
  assert.equal(f.launches[0].stopped, true);
});

test('steering racing idle is consumed by the same runtime before completion and shutdown', async t => {
  const f = fixture(t);
  let completed = false;
  const run = f.run().then(result => { completed = true; return result; });
  await f.ready();
  const runtime = f.launches[0];
  let acknowledge;
  runtime.delayedSteering = () => new Promise(resolve => { acknowledge = resolve; });
  const steering = f.steer('Refine at the idle boundary');
  runtime.finish('initial answer');
  await Promise.resolve();
  assert.equal(completed, false);
  acknowledge('late-message');
  await steering;
  assert.equal(completed, false);
  assert.notEqual(runtime.stopped, true);
  runtime.emit({ type: 'user.message', data: { messageId: 'late-message', content: 'Refine' } });
  runtime.emit({ type: 'assistant.turn_start', data: {} });
  runtime.finish('refined answer');
  assert.equal((await run).summary, 'refined answer');
  assert.equal(f.launches.length, 1);
});

test('permission handler cannot broaden approved tools or bypass managed policy', async t => {
  assert.equal(preauthorizedPermission({ kind: 'read' }, ['view']), true);
  assert.equal(preauthorizedPermission({ kind: 'shell' }, ['view']), false);
  assert.equal(preauthorizedPermission({ kind: 'write' }, ['view']), false);
  assert.equal(preauthorizedPermission({ kind: 'write' }, ['edit']), true);
  assert.equal(preauthorizedPermission({ kind: 'shell' }, ['powershell']), true);
  assert.equal(preauthorizedPermission({ kind: 'url' }, ['powershell']), false);
  assert.equal(preauthorizedPermission({ kind: 'read', managedApprovalRequired: true }, ['view']), false);
  const f = fixture(t);
  const run = f.run();
  const rejected = assert.rejects(run, /cancelled/);
  await f.ready();
  const handler = f.launches[0].config.onPermissionRequest;
  assert.deepEqual(handler({ kind: 'read' }), { kind: 'approve-once' });
  const permission = handler({ kind: 'shell' });
  f.controller.abort();
  assert.equal(permission.kind, 'no-result');
  await rejected;
  assert.equal(f.currentResponder(), null);
});

for (const decision of ['approve-once', 'reject']) {
  test(`SDK applies ${decision} only to the exact pending permission, preserving the worker and allowlist`, async t => {
    const f = fixture(t);
    const run = f.run();
    await f.ready();
    const runtime = f.launches[0];
    const permissionRequest = { kind: 'read', managedApprovalRequired: true };
    assert.equal(runtime.config.onPermissionRequest(permissionRequest).kind, 'no-result');
    runtime.emit({ type: 'permission.requested', data: { requestId: 'pending', permissionRequest } });
    await assert.rejects(f.respond('foreign', decision), /stale/);
    await f.respond('pending', decision);
    assert.deepEqual(runtime.decisions.map(item => [item.requestId, item.result.kind]), [['pending', decision]]);
    await assert.rejects(f.respond('pending', decision), /stale/);
    assert.deepEqual(runtime.config.availableTools, ['view']);
    assert.notEqual(runtime.stopped, true);
    runtime.finish();
    await run;
    assert.equal(f.currentResponder(), null);
  });
}

test('SDK does not report a stale provider decision as accepted or allow its replay', async t => {
  const f = fixture(t);
  const run = f.run();
  await f.ready();
  const runtime = f.launches[0];
  runtime.decide = async () => {
    runtime.emit({ type: 'permission.completed', data: { requestId: 'pending' } });
    return { success: false };
  };
  runtime.emit({ type: 'permission.requested', data: {
    requestId: 'pending', permissionRequest: { kind: 'url' },
  } });
  await assert.rejects(f.respond('pending', 'approve-once'), /already resolved/);
  await assert.rejects(f.respond('pending', 'approve-once'), /stale/);
  runtime.finish();
  await run;
});

test('SDK retains its runtime through permission acknowledgement racing the final answer', async t => {
  const f = fixture(t);
  const run = f.run();
  await f.ready();
  const runtime = f.launches[0];
  let acknowledge;
  runtime.decide = () => new Promise(resolve => { acknowledge = resolve; });
  runtime.emit({ type: 'permission.requested', data: {
    requestId: 'pending', permissionRequest: { kind: 'url' },
  } });
  const decision = f.respond('pending', 'approve-once');
  runtime.emit({ type: 'permission.completed', data: { requestId: 'pending' } });
  runtime.finish();
  await Promise.resolve();
  assert.notEqual(runtime.stopped, true);
  acknowledge({ success: true });
  await decision;
  await run;
  assert.equal(runtime.stopped, true);
});

test('SDK worker survives four minutes and stops at exactly one hour of execution', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const f = fixture(t);
  const run = f.run();
  const rejected = assert.rejects(run, /one-hour worker execution/);
  await f.ready();
  t.mock.timers.tick(240000);
  assert.notEqual(f.launches[0].stopped, true);
  t.mock.timers.tick(3359999);
  assert.notEqual(f.launches[0].stopped, true);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.launches[0].stopped, true);
});

test('preapproved permission churn never reaches Plex, while an explicit managed ask remains actionable', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture(t);
  const run = f.run();
  await f.ready();
  const runtime = f.launches[0];
  for (let i = 0; i < 120; i++) fs.appendFileSync(runtime.file, [
    { type: 'permission.requested', data: { requestId: `auto-${i}`, permissionRequest: { kind: 'read' } } },
    { type: 'permission.completed', data: { requestId: `auto-${i}` } },
  ].map(item => JSON.stringify(item) + '\n').join(''));
  const managed = { type: 'permission.requested', data: {
    requestId: 'managed', permissionRequest: { kind: 'read', managedApprovalRequired: true },
  } };
  runtime.emit(managed);
  fs.appendFileSync(runtime.file, JSON.stringify(managed) + '\n');
  t.mock.timers.tick(500);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.deepEqual(f.permissions.map(item => item.requestId), ['managed']);
  await f.respond('managed', 'approve-once');
  fs.appendFileSync(runtime.file, JSON.stringify({ type: 'permission.completed', data: { requestId: 'managed' } }) + '\n');
  runtime.finish();
  await run;
  assert.deepEqual(f.permissions.map(item => item.status), ['requested', 'completed']);
});

test('SDK exposes ask_user only for a connected Plex brain and returns its answer without broadening tools', async t => {
  const f = fixture(t);
  const questions = [];
  const run = f.run({ onQuestion: async (question, signal) => {
    assert.equal(signal.aborted, false);
    questions.push(question);
    return { answer: 'Existing convention', wasFreeform: true };
  } });
  await f.ready();
  const runtime = f.launches[0];
  assert.deepEqual(runtime.config.availableTools, ['view', 'ask_user']);
  assert.equal(runtime.options.connection.args.includes('--no-ask-user'), false);
  assert.deepEqual(await runtime.config.onUserInputRequest({ question: 'Which convention?' }),
    { answer: 'Existing convention', wasFreeform: true });
  assert.equal(questions.length, 1);
  runtime.finish();
  await run;
});

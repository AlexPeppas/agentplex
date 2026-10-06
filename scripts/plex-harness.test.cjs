const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { fakeAmqp } = require('./plex-fake-amqp.cjs');

const result = { status: 'completed', summary: 'Done', evidence: [], limitations: [] };
const blueprint = () => ({ id: 'squad', name: 'Engineering', revision: 1, agents: [
  { id: 'arch', name: 'dev-arch', description: 'Architecture review', instructions: 'Cite evidence', tools: ['view', 'rg'] },
] });
function fixture(t, custom) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-harness-test-'));
  const root = path.join(parent, 'plex');
  const amqp = fakeAmqp();
  const { PlexHarness } = loadSource('src/main/plex-harness.ts', { amqplib: amqp.amqp });
  const calls = [];
  const runner = async req => {
    calls.push(req);
    const input = JSON.parse(req.prompt);
    if (custom) await custom(req, input);
    if (req.schema.properties.requests) return { message: 'Workers continue; here is the status.', requests: [] };
    if (req.schema.properties.tasks) {
      return { message: 'Proposed architecture review', squadId: null, tasks: [{
        id: 'inspect', title: 'Inspect architecture', instructions: 'Read evidence', acceptance: 'Cite evidence',
        dependsOn: [], agentId: input.resources.agents[0].id, memberIndex: null,
      }] };
    }
    return result;
  };
  const harness = new PlexHarness(root, runner, () => {});
  t.after(() => { harness.dispose(); fs.rmSync(parent, { recursive: true, force: true }); });
  harness.saveBlueprint(blueprint());
  return { parent, root, harness, calls, amqp, restore: () => new PlexHarness(root, runner, () => {}) };
}

test('mounted conversations isolate coordinator and worker histories and run concurrently', async t => {
  let active = 0;
  let high = 0;
  const f = fixture(t, async req => {
    if (req.readOnly) {
      high = Math.max(high, ++active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active--;
    }
  });
  const directories = { 'chat-a': path.join(f.parent, 'workspace-a'), 'chat-b': path.join(f.parent, 'workspace-b') };
  Object.values(directories).forEach(directory => fs.mkdirSync(directory));
  f.harness.createConversation(directories['chat-a'], 'squad', 'chat-a');
  f.harness.createConversation(directories['chat-b'], 'squad', 'chat-b');
  const initial = f.harness.snapshot();
  assert.notEqual(initial.conversations[0].rootJobId, initial.conversations[1].rootJobId);
  assert.notEqual(initial.states['chat-a'].agents[0].id, initial.states['chat-b'].agents[0].id);
  await Promise.all([f.harness.chat('chat-a', 'msg-a', 'Review A'), f.harness.chat('chat-b', 'msg-b', 'Review B')]);
  const pending = f.harness.snapshot();
  await Promise.all(['chat-a', 'chat-b'].map(id => f.harness.approve(id, pending.states[id].approvalId)));
  assert.equal(high, 2);
  const homes = f.calls.filter(req => req.readOnly).map(req => req.conversationHome);
  assert.notEqual(homes[0], homes[1]);
  const assertMountedDirectories = () => {
    for (const req of f.calls) {
      const chatId = Object.keys(directories).find(id => req.conversationHome.includes(`${path.sep}${id}${path.sep}`));
      assert.ok(chatId);
      assert.equal(req.cwd, fs.realpathSync(directories[chatId]));
      assert.notEqual(req.cwd, req.conversationHome);
    }
  };
  assertMountedDirectories();
  const asks = f.amqp.publications.filter(item => item.exchange.endsWith('.asks'));
  assert.deepEqual(new Set(asks.map(item => item.payload.conversationId)), new Set(['chat-a', 'chat-b']));
  assert.ok(asks.every(item => item.payload.assignmentId === item.payload.jobId && item.payload.agentId === 'arch'));
  await f.harness.chat('chat-a', 'msg-followup', 'Continue review A');
  await f.harness.approve('chat-a', f.harness.snapshot().states['chat-a'].approvalId);
  assert.equal(f.calls.filter(req => req.readOnly).at(-1).conversationHome, homes[0]);
  const restored = f.restore();
  await restored.chat('chat-a', 'msg-restored', 'Continue after restart');
  await restored.approve('chat-a', restored.snapshot().states['chat-a'].approvalId);
  assert.equal(f.calls.filter(req => req.readOnly).at(-1).conversationHome, homes[0]);
  assertMountedDirectories();
  restored.dispose();
});

test('multiplexer rejects mismatched or removed mounts before invoking a CLI', async t => {
  const f = fixture(t);
  const directory = path.join(f.parent, 'mounted');
  fs.mkdirSync(directory);
  f.harness.createConversation(directory, 'squad', 'chat');
  const state = f.harness.snapshot().states.chat;
  const { PlexMultiplexer } = loadSource('src/main/plex-multiplexer.ts');
  let launched = false;
  const mux = new PlexMultiplexer(f.root, {}, async () => { launched = true; }, state.mount);
  const agent = state.agents[0];
  const job = { workerId: agent.id, claimToken: 'synthetic' };
  await assert.rejects(mux.execute({ ...agent, cwd: f.parent }, job, new AbortController().signal, async () => {}), /conversation mount/);
  fs.rmdirSync(directory);
  await assert.rejects(mux.execute(agent, job, new AbortController().signal, async () => {}), /ENOENT/);
  assert.equal(launched, false);
});

test('worker approval events stay in their mounted conversation and wait for every request to resolve', async t => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  let release;
  const f = fixture(t, async req => {
    if (!req.readOnly || !req.conversationHome.includes(`${path.sep}chat-a${path.sep}`)) return;
    await req.onPermission({ requestId: 'one', status: 'requested', command: 'Get-Content sample.txt' });
    await req.onPermission({ requestId: 'one', status: 'requested' });
    await req.onPermission({ requestId: 'two', status: 'requested' });
    await req.onPermission({ requestId: 'one', status: 'completed' });
    await new Promise(resolve => {
      release = resolve;
      req.signal.addEventListener('abort', resolve, { once: true });
      ready();
    });
    if (req.signal.aborted) return;
    await req.onPermission({ requestId: 'two', status: 'completed' });
  });
  for (const id of ['chat-a', 'chat-b']) {
    f.harness.createConversation(f.parent, 'squad', id);
    await f.harness.chat(id, `msg-${id}`, 'Review');
  }
  const a = f.harness.approve('chat-a', f.harness.snapshot().states['chat-a'].approvalId);
  await waiting;
  const snapshot = f.harness.snapshot();
  assert.equal(snapshot.states['chat-a'].phase, 'waiting-for-approval');
  assert.equal(snapshot.states['chat-a'].agents[0].status, 'waiting-for-approval');
  assert.deepEqual(snapshot.states['chat-a'].tasks[0].permissions.map(p => p.status), ['resolved', 'pending']);
  assert.equal(snapshot.conversations.find(c => c.conversationId === 'chat-a').phase, 'waiting-for-approval');
  assert.equal(snapshot.states['chat-b'].tasks[0].permissions, undefined);
  await f.harness.chat('chat-a', 'another', 'What is the status?');
  assert.equal(f.harness.snapshot().states['chat-a'].phase, 'waiting-for-approval');
  await f.harness.approve('chat-b', snapshot.states['chat-b'].approvalId);
  assert.equal(f.harness.snapshot().states['chat-b'].phase, 'idle');
  assert.equal(f.harness.snapshot().states['chat-a'].phase, 'waiting-for-approval');
  release();
  await a;
  const final = f.harness.snapshot();
  assert.equal(final.states['chat-a'].phase, 'idle');
  assert.deepEqual(final.states['chat-a'].tasks[0].permissions.map(p => p.status), ['resolved', 'resolved']);
  const publications = f.amqp.publications.filter(item => item.payload.eventType === 'permission');
  assert.equal(publications.length, 5);
  assert.ok(publications.every(item => item.payload.conversationId === 'chat-a' &&
    item.payload.assignmentId === item.payload.jobId && item.payload.claimToken));
  const synthesis = JSON.parse(f.calls.at(-1).prompt);
  assert.deepEqual(synthesis.tasks[0].permissions.map(p => p.status), ['resolved', 'resolved']);
});

test('cancelling an approval wait affects only its conversation; restart interrupts the other wait', async t => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  let count = 0;
  const f = fixture(t, async req => {
    if (!req.readOnly) return;
    await req.onPermission({ requestId: 'same-provider-id', status: 'requested' });
    await new Promise(resolve => {
      req.signal.addEventListener('abort', resolve, { once: true });
      if (++count === 2) ready();
    });
  });
  const runs = [];
  for (const id of ['chat-a', 'chat-b']) {
    f.harness.createConversation(f.parent, 'squad', id);
    await f.harness.chat(id, `msg-${id}`, 'Review');
    runs.push(f.harness.approve(id, f.harness.snapshot().states[id].approvalId));
  }
  await waiting;
  f.harness.cancel('chat-a');
  await runs[0];
  let snapshot = f.harness.snapshot();
  assert.equal(snapshot.states['chat-a'].tasks[0].permissions[0].status, 'interrupted');
  assert.equal(snapshot.states['chat-b'].tasks[0].permissions[0].status, 'pending');
  f.harness.dispose();
  await runs[1];
  const restored = f.restore();
  snapshot = restored.snapshot();
  assert.equal(snapshot.states['chat-b'].phase, 'interrupted');
  assert.equal(snapshot.states['chat-b'].tasks[0].permissions[0].status, 'interrupted');
  assert.equal(snapshot.states['chat-b'].tasks[0].status, 'blocked');
  assert.equal(count, 2);
  restored.dispose();
});

test('restoration rejects a worker cwd that differs from the saved conversation mount', t => {
  const f = fixture(t);
  f.harness.createConversation(f.parent, 'squad', 'chat');
  const file = path.join(f.root, 'chats', 'chat', 'state.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.agents[0].cwd = f.root;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => f.restore(), /agent instance does not match the conversation mount/);
});

test('blueprint model is snapshotted, forwarded on every worker turn and retained after restart', async t => {
  const f = fixture(t);
  f.harness.saveBlueprint({ ...blueprint(), agents: [{ ...blueprint().agents[0], model: 'model-one' }] });
  f.harness.createConversation(f.parent, 'squad', 'chat');
  f.harness.saveBlueprint({ ...blueprint(), revision: 2, agents: [{ ...blueprint().agents[0], model: 'model-two' }] });
  await f.harness.chat('chat', 'message', 'Review');
  await f.harness.approve('chat', f.harness.snapshot().states.chat.approvalId);
  const worker = f.calls.find(req => req.readOnly);
  assert.equal(worker.model, 'model-one');
  const restored = f.restore();
  await restored.chat('chat', 'next', 'Review again');
  await restored.approve('chat', restored.snapshot().states.chat.approvalId);
  assert.equal(f.calls.filter(req => req.readOnly).at(-1).model, 'model-one');
  assert.equal(restored.snapshot().states.chat.agents[0].model, 'model-one');
  restored.dispose();
});

test('streamed worker activity and transcript access are scoped to the owning chat, not the selected chat', async t => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  let release;
  const f = fixture(t, async req => {
    if (!req.readOnly) {
      await req.onActivity([{ id: 'brain', kind: 'assistant', text: 'Planning in progress' }]);
      return;
    }
    await req.onActivity([{ id: 'tool', kind: 'tool', text: 'view sample.txt' }]);
    await new Promise(resolve => { release = resolve; req.signal.addEventListener('abort', resolve, { once: true }); ready(); });
  });
  f.harness.createConversation(f.parent, 'squad', 'chat-a');
  f.harness.createConversation(f.parent, 'squad', 'chat-b');
  const agentA = f.harness.snapshot().states['chat-a'].agents[0].id;
  assert.equal(f.harness.transcript('chat-a', agentA).started, false);
  assert.throws(() => f.harness.transcript('chat-b', agentA), /does not belong/);
  assert.throws(() => f.harness.transcript('chat-a', '..\\escape'), /Invalid Plex ID/);
  await f.harness.chat('chat-a', 'message', 'Inspect');
  const run = f.harness.approve('chat-a', f.harness.snapshot().states['chat-a'].approvalId);
  await waiting;
  assert.equal(f.harness.snapshot().states['chat-a'].tasks[0].activity[0].text, 'view sample.txt');
  assert.deepEqual(f.harness.snapshot().states['chat-b'].tasks, []);
  release();
  await run;
  assert.ok(f.amqp.publications.some(item => item.payload.eventType === 'activity' && item.payload.conversationId === 'chat-a'));
});

test('plan decisions reach subsequent brain prompts and stale rejection cannot cancel approved execution', async t => {
  let ready;
  const waiting = new Promise(resolve => { ready = resolve; });
  let release;
  const f = fixture(t, async req => {
    if (!req.readOnly) return;
    await new Promise(resolve => { release = resolve; req.signal.addEventListener('abort', resolve, { once: true }); ready(); });
  });
  f.harness.createConversation(f.parent, 'squad', 'chat');
  await f.harness.chat('chat', 'first', 'Review');
  const rejected = f.harness.snapshot().states.chat.approvalId;
  f.harness.cancel('chat', rejected);
  assert.equal(f.harness.snapshot().states.chat.planDecision.status, 'rejected');
  await f.harness.chat('chat', 'second', 'Revised review');
  const planning = JSON.parse(f.calls.at(-1).prompt);
  assert.equal(planning.approvalState.lastDecision.approvalId, rejected);
  assert.equal(planning.approvalState.lastDecision.status, 'rejected');
  const approved = f.harness.snapshot().states.chat.approvalId;
  const run = f.harness.approve('chat', approved);
  await waiting;
  assert.throws(() => f.harness.cancel('chat', approved), /stale/);
  assert.throws(() => f.harness.cancel('chat', rejected), /stale/);
  assert.ok(f.harness.snapshot().states.chat.messages.some(message => message.text.includes(`Plan approved (${approved})`)));
  release();
  await run;
  assert.equal(JSON.parse(f.calls.at(-1).prompt).planDecision.status, 'approved');
  const restored = f.restore();
  assert.equal(restored.snapshot().states.chat.planDecision.approvalId, approved);
  restored.dispose();
});

test('ingress deduplicates retries, rejects conflicts, and accepts distinct followups', async t => {
  const f = fixture(t);
  f.harness.createConversation(f.parent, 'squad', 'chat');
  f.harness.createConversation(f.parent, 'squad', 'chat');
  assert.equal(f.harness.snapshot().conversations.length, 1);
  await Promise.all([f.harness.chat('chat', 'message', 'Review'), f.harness.chat('chat', 'message', 'Review')]);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.harness.chat('chat', 'message', 'Different'), /Conflicting/);
  const approvalId = f.harness.snapshot().states.chat.approvalId;
  await assert.rejects(f.harness.approve('chat', 'wrong-plan'), /stale/);
  f.harness.cancel('chat', approvalId);
  await f.harness.chat('chat', 'followup', 'Review again');
  await assert.rejects(f.harness.approve('chat', approvalId), /stale/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.amqp.publications.length, 0);
  const restored = f.restore();
  await restored.chat('chat', 'message', 'Review');
  assert.equal(f.calls.length, 2);
  restored.dispose();
});

test('mount snapshots preserve tools and instructions when a blueprint changes or is deleted', async t => {
  const f = fixture(t);
  f.harness.createConversation(f.parent, 'squad', 'chat');
  f.harness.saveBlueprint({ ...blueprint(), agents: [{ ...blueprint().agents[0], tools: ['powershell'] }] });
  assert.throws(() => f.harness.saveBlueprint(blueprint()), /changed/);
  f.harness.deleteBlueprint('squad');
  await f.harness.chat('chat', 'msg', 'Inspect');
  const state = f.harness.snapshot().states.chat;
  assert.deepEqual(state.agents[0].tools, ['view', 'rg']);
  await f.harness.approve('chat', state.approvalId);
  const worker = f.calls.find(req => req.readOnly);
  assert.deepEqual(worker.tools, ['view', 'rg']);
  assert.equal(JSON.parse(worker.prompt).agentInstructions, 'Cite evidence');
});

test('blueprint validation rejects unknown tools, empty squads and invalid identities', t => {
  const f = fixture(t);
  assert.throws(() => f.harness.saveBlueprint({ ...blueprint(), agents: [] }), /1-4/);
  assert.throws(() => f.harness.saveBlueprint({ ...blueprint(), agents: [{ ...blueprint().agents[0], tools: ['allow-all'] }] }), /unsupported/);
  assert.throws(() => f.harness.createConversation(f.parent, 'squad', '..\\escape'), /Invalid Plex ID/);
  assert.throws(() => f.harness.createConversation('relative', 'squad', 'chat'), /workspace/);
});

test('migration preserves original templates and excludes mixed providers explicitly', t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-migration-test-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const original = JSON.stringify([
    { id: 'yes', name: 'Review', sessions: [{ name: 'Architect', cli: 'copilot', cwd: parent, sessionId: 'old' }] },
    { id: 'no', name: 'Mixed', sessions: [{ name: 'Claude', cli: 'claude', cwd: parent }] },
  ]);
  fs.writeFileSync(path.join(parent, 'templates.json'), original);
  const { PlexHarness } = loadSource('src/main/plex-harness.ts');
  const service = new PlexHarness(path.join(parent, 'plex'), async () => { throw new Error('Must not execute'); }, () => {});
  const workspace = service.snapshot();
  assert.equal(workspace.blueprints.length, 1);
  assert.equal(workspace.conversations.length, 0);
  assert.ok(workspace.migrationNotes.some(note => note.includes('Mixed')));
  assert.equal(fs.readFileSync(path.join(parent, 'templates.json'), 'utf8'), original);
  assert.equal(workspace.blueprints[0].agents[0].sessionId, undefined);
  assert.equal(workspace.blueprints[0].agents[0].cwd, undefined);
  service.dispose();
});

test('late workspace responses cannot replace a newer background-chat update', () => {
  const { usePlexStore } = loadSource('src/renderer/plex-store.ts');
  const base = { conversations: [], blueprints: [], migrationNotes: [], states: {} };
  usePlexStore.getState().setWorkspace({ ...base, revision: 3 });
  usePlexStore.getState().setWorkspace({ ...base, revision: 2 });
  assert.equal(usePlexStore.getState().workspace.revision, 3);
});

test('CLI allowlist and permissions follow each checked tool without enabling an unselected shell', async t => {
  const { EventEmitter } = require('node:events');
  const previous = process.env.COPILOT_GITHUB_TOKEN;
  process.env.COPILOT_GITHUB_TOKEN = 'synthetic-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previous;
  });
  const launches = [];
  const { runPlexCli } = loadSource('src/main/plex-cli.ts', {
    'node:child_process': { spawn: (command, args, options) => {
      assert.equal(options.cwd, process.cwd());
      launches.push(args);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
      child.stdout.setEncoding = child.stderr.setEncoding = () => {};
      child.stdin.end = () => queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({ type: 'assistant.message', data: { content: '{"summary":"ok"}' } }) + '\n' +
          JSON.stringify({ type: 'result', exitCode: 0 }));
        child.emit('close', 0);
      });
      return child;
    } },
  });
  const request = { cwd: process.cwd(), prompt: 'Synthetic', readOnly: true, schema: {}, signal: new AbortController().signal };
  await runPlexCli({ ...request, tools: ['edit'] });
  assert.ok(launches[0].includes('--available-tools=edit'));
  assert.ok(launches[0].includes('--allow-tool=write'));
  assert.ok(launches[0].includes('--deny-tool=shell'));
  await runPlexCli({ ...request, tools: [] });
  assert.ok(launches[1].includes('--available-tools='));
  assert.ok(launches[1].includes('--deny-tool=write'));
  await runPlexCli({ ...request, tools: ['powershell'] });
  assert.ok(launches[2].includes('--allow-tool=shell'));
  assert.ok(launches[2].includes('--available-tools=powershell'));
  await runPlexCli({ ...request, readOnly: false });
  assert.ok(launches[3].includes('--available-tools=view,glob,rg,create,edit,powershell,read_powershell,stop_powershell,list_powershell,web_search,github-mcp-server-web_search,web_fetch,session_store_sql'));
  assert.ok(launches[3].includes('--allow-tool=github-mcp-server(web_search)'));
  assert.ok(launches[3].includes('--add-github-mcp-tool=web_search'));
  assert.ok(launches[3].includes('--disable-mcp-server=githubiq'));
  assert.ok(!launches[3].includes('--disable-builtin-mcps'));
  assert.ok(launches[3].includes('--allow-all-urls'));
  assert.ok(launches[3].includes('--allow-tool=write'));
  assert.ok(launches[3].includes('--allow-tool=shell'));
  assert.ok(!launches[3].includes('--deny-tool=write'));
  assert.ok(!launches[3].includes('--deny-tool=shell'));
  assert.ok(launches.slice(0, 3).every(args => !args.includes('--allow-all-urls')));
  assert.ok(launches.slice(0, 3).every(args => args.includes('--disable-builtin-mcps')));
  assert.ok(launches.every(args => !args.includes('--allow-all-tools') && !args.includes('--allow-all-paths')));
  await assert.rejects(runPlexCli({ ...request, tools: ['unknown-tool'] }), /unsupported/);
  assert.equal(launches.length, 4);
});

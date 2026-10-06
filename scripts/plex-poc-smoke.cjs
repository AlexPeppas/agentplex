// Isolated UI/harness test by default. --live-mission uses real RabbitMQ and Copilot on synthetic files only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const electron = require('electron');

async function testRenderer(root, fixture) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [root] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [root] }));
  const { ReactFlowProvider } = require(require.resolve('@xyflow/react', { paths: [root] }));
  const { loadSource } = require(path.join(root, 'scripts', 'test-support.cjs'));
  const amqp = require(path.join(root, 'scripts', 'plex-fake-amqp.cjs')).fakeAmqp();
  const { PlexHarness } = loadSource('src/main/plex-harness.ts', { amqplib: amqp.amqp });
  const plexStore = loadSource('src/renderer/plex-store.ts');
  const appStore = loadSource('src/renderer/store.ts', { './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false } });
  const overrides = {
    '../assets/plex-contact-blob.json': require(path.join(root, 'src', 'renderer', 'assets', 'plex-contact-blob.json')),
    '../plex-store': plexStore, '../../plex-store': plexStore, '../store': appStore,
    '@xyflow/react/dist/style.css': {}, './SessionNode': { SessionNode: () => null },
    './GroupNode': { GroupNode: () => null }, './SubAgentNode': { SubAgentNode: () => null },
    './DrawingOverlay': { DrawingOverlay: () => null },
  };
  const { PlexChat } = loadSource('src/renderer/components/PlexChat.tsx', overrides);
  const { PlexWorkerChat } = loadSource('src/renderer/components/PlexWorkerChat.tsx', overrides);
  const { SquadsPanel } = loadSource('src/renderer/components/panels/SquadsPanel.tsx', overrides);
  const { GraphCanvas } = loadSource('src/renderer/components/GraphCanvas.tsx', overrides);
  // about:blank in this Node-enabled test window is not a secure browser origin.
  if (!globalThis.crypto.randomUUID) globalThis.crypto.randomUUID = require('node:crypto').randomUUID;
  const style = document.createElement('style');
  style.textContent = require('node:fs').readFileSync(require.resolve('@xyflow/react/dist/style.css', { paths: [root] }), 'utf8') +
    'body{margin:0}.w-full{width:100%}.h-full{height:100%}.relative{position:relative}aside{position:absolute;right:0;top:0;width:440px;height:760px;overflow:auto;background:white;z-index:50}';
  document.head.append(style);
  const events = new Set();
  let workers = 0;
  let permissionMode = false;
  let questionMode = false;
  let workerAnswer;
  const permissionDecisions = [];
  let releasePermission;
  const permissionGate = new Promise(resolve => { releasePermission = resolve; });
  const service = new PlexHarness(path.join(fixture, 'plex'), async req => {
    await req.onActivity?.([{ id: 'synthetic-live', kind: req.readOnly ? 'tool' : 'assistant',
      text: req.readOnly ? 'view sample.txt' : 'Preparing the response...' }]);
    await new Promise(resolve => setTimeout(resolve, 20));
    if (req.schema.properties.requests) return { message: 'Plex can answer while the worker waits.', requests: [] };
    if (req.schema.properties.questionDecision) return {
      questionDecision: 'human', answer: '', reason: 'The user must select the environment.',
      continuation: { scope: 'needs-human', reason: 'Target not specified', tasks: [] },
    };
    if (req.schema.properties.tasks) {
      const input = JSON.parse(req.prompt);
      return { message: 'Inspect sample', squadId: null, tasks: [{
        id: 'inspect', title: 'Inspect fixture', instructions: 'Read sample.txt', acceptance: 'Cite file',
        dependsOn: [], agentId: input.resources.agents[0].id, memberIndex: null,
      }] };
    }
    if (req.readOnly) {
      workers++;
      if (questionMode) workerAnswer = await req.onQuestion({
        question: 'Which environment should be reviewed?', choices: ['staging', 'production'], allowFreeform: false,
      }, req.signal);
      if (!permissionMode) {
        await req.onPermission({ requestId: 'legacy-preapproved', status: 'requested', kind: 'read' });
        await req.onPermission({ requestId: 'legacy-preapproved', status: 'completed' });
      }
      if (permissionMode) {
        await permissionGate;
        for (let i = 0; i < 3 && !req.signal.aborted; i++) {
          const requestId = `synthetic-permission-${i}`;
          let release;
          const answered = new Promise(resolve => { release = resolve; });
          req.registerPermissionResponder(async (id, decision) => {
            assert.equal(id, requestId);
            permissionDecisions.push(decision);
            await req.onPermission({ requestId, status: 'completed' });
            release();
          });
          await req.onPermission({ requestId, status: 'requested',
            kind: 'shell', command: 'Get-Content sample.txt', description: 'Read synthetic sample' });
          await Promise.race([answered, new Promise(resolve => req.signal.addEventListener('abort', resolve, { once: true }))]);
        }
        req.registerPermissionResponder(null);
      }
    }
    return { status: 'completed', summary: 'Collected findings', evidence: ['sample.txt:1'], limitations: [] };
  }, next => events.forEach(callback => callback(next)));
  window.agentPlex = {
    plexModels: async () => [{ id: 'synthetic-model', name: 'Synthetic Model', enabled: true }],
    plexTranscript: async (id, agentId) => {
      assert.ok(service.snapshot().states[id].agents.some(agent => agent.id === agentId));
      return { started: true, truncated: false, entries: [{ id: 'public', kind: 'assistant', text: 'Read-only public worker reply' }] };
    },
    plexWorkspace: async () => service.snapshot(),
    plexSaveBlueprint: async blueprint => service.saveBlueprint(blueprint),
    plexDeleteBlueprint: async id => service.deleteBlueprint(id),
    plexCreateConversation: async (cwd, blueprint, id) => service.createConversation(cwd, blueprint, id),
    plexChat: (message, id, messageId) => service.chat(id, messageId, message),
    plexApprove: (id, approvalId) => service.approve(id, approvalId),
    plexCancel: async (id, approvalId) => service.cancel(id, approvalId),
    plexPermissionDecision: (id, jobId, requestId, decision) => service.decidePermission(id, jobId, requestId, decision),
    plexAnswerQuestion: (id, questionId, answer) => service.answerQuestion(id, questionId, answer),
    onPlexChanged: callback => { events.add(callback); return () => events.delete(callback); },
    pickDirectory: async () => fixture,
  };
  const host = document.createElement('div');
  host.style.cssText = 'width:1200px;height:760px;position:relative';
  document.body.append(host);
  const reactRoot = createRoot(host);
  const waitFor = async predicate => {
    for (let n = 0; n < 150; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    throw new Error(`UI timed out: ${host.textContent}`);
  };
  const button = text => [...host.querySelectorAll('button')].find(item => item.textContent === text);
  const change = (element, value) => {
    Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
      element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  reactRoot.render(React.createElement(SquadsPanel));
  await waitFor(() => button('New Squad blueprint'));
  button('New Squad blueprint').click();
  await waitFor(() => button('Save blueprint'));
  await waitFor(() => [...host.querySelector('[aria-label="Agent 1 model"]').options].some(option => option.value === 'synthetic-model'));
  change(host.querySelector('[aria-label="Agent 1 model"]'), 'synthetic-model');
  await waitFor(() => host.querySelector('[aria-label="Agent 1 model"]').value === 'synthetic-model');
  assert.equal(host.querySelectorAll('input[type="checkbox"]').length, 6);
  button('Save blueprint').click();
  await waitFor(() => service.snapshot().blueprints.length === 1);
  const blueprint = service.snapshot().blueprints[0];
  assert.deepEqual(blueprint.agents[0].tools, ['view', 'glob', 'rg']);
  assert.equal(blueprint.agents[0].model, 'synthetic-model');
  plexStore.usePlexStore.getState().setOpen(true);
  reactRoot.render(React.createElement(ReactFlowProvider, null, React.createElement(GraphCanvas),
    React.createElement(PlexChat), React.createElement(PlexWorkerChat)));
  await waitFor(() => host.querySelector('[aria-label="Mount Squad blueprint"]'));
  await waitFor(() => host.querySelector('[data-plex-mascot="welcome"] svg'));
  change(host.querySelector('[aria-label="Mount Squad blueprint"]'), blueprint.id);
  await waitFor(() => !button('Choose folder and create chat').disabled);
  button('Choose folder and create chat').click();
  await waitFor(() => service.snapshot().conversations.length === 1 && host.querySelector('[data-id="plex:coordinator"]'));
  const firstId = service.snapshot().conversations[0].conversationId;
  change(host.querySelector('[aria-label="Message Plex"]'), 'Inspect the fixture');
  await waitFor(() => !button('Send').disabled);
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => button('Reject plan') && !button('Reject plan').disabled);
  await waitFor(() => host.querySelector('[data-plex-mascot="compact"] svg'));
  assert.ok(host.querySelector('[aria-label="Proposed plan"]').className.includes('bg-purple-400/15'));
  assert.ok(host.querySelector('[aria-label="Plan approval"]').className.includes('bg-purple-400/15'));
  assert.equal(workers, 0);
  button('Reject plan').click();
  await waitFor(() => host.textContent.includes('Plan rejected'));
  change(host.querySelector('[aria-label="Message Plex"]'), 'Inspect again');
  await waitFor(() => !button('Send').disabled);
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => button('Approve plan') && !button('Approve plan').disabled);
  button('Approve plan').click();
  await waitFor(() => host.textContent.includes('Collected findings'));
  assert.equal(host.querySelector('[aria-label="Worker approval request"]'), null, 'resolved preapprovals must not bloat chat');
  assert.ok(host.textContent.includes('Plan approved ('));
  assert.equal(host.querySelector('[aria-label="Plex chat"]').textContent.includes('view sample.txt'), false);
  host.querySelector('[data-id^="plex:agent:"] button').click();
  await waitFor(() => host.textContent.includes('Read-only public worker reply'));
  assert.equal(host.querySelector('[aria-label="Worker chat"]').querySelector('textarea'), null);
  assert.equal(host.querySelector('[aria-label="Plex chat"]').textContent.includes('Read-only public worker reply'), false);
  assert.equal(workers, 1, 'opening the transcript cannot invoke the worker');
  button('New chat').click();
  await waitFor(() => button('Choose folder and create chat'));
  button('Choose folder and create chat').click();
  await waitFor(() => service.snapshot().conversations.length === 2);
  assert.equal(host.textContent.includes('Collected findings'), false);
  assert.equal(host.querySelector('[aria-label="Worker chat"]').textContent.includes('Read-only public worker reply'), true);
  host.querySelector('[aria-label="Close worker chat"]').click();
  await waitFor(() => !host.querySelector('[aria-label="Worker chat"]'));
  change(host.querySelector('[aria-label="Plex conversation"]'), firstId);
  await waitFor(() => host.textContent.includes('Collected findings'));
  assert.equal(workers, 1);
  assert.ok(host.querySelector('[data-id^="plex:agent:"]'));
  const secondId = service.snapshot().conversations.find(chat => chat.conversationId !== firstId).conversationId;
  permissionMode = true;
  change(host.querySelector('[aria-label="Message Plex"]'), 'Review with a synthetic permission request');
  await waitFor(() => !button('Send').disabled);
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => button('Approve plan') && !button('Approve plan').disabled);
  button('Approve plan').click();
  await waitFor(() => workers === 2);
  change(host.querySelector('[aria-label="Plex conversation"]'), secondId);
  await waitFor(() => plexStore.usePlexStore.getState().selectedId === secondId);
  releasePermission();
  await waitFor(() => host.textContent.includes('Action required:'));
  assert.equal(host.querySelector('[aria-label="Worker approval request"]'), null);
  assert.equal(host.textContent.includes('synthetic-permission'), false);
  assert.equal(service.snapshot().states[secondId].phase, 'idle');
  [...host.querySelectorAll('button')].find(item => item.textContent.startsWith('Action required:')).click();
  await waitFor(() => host.querySelector('[aria-label="Worker approval request"]'));
  assert.equal(plexStore.usePlexStore.getState().selectedId, firstId);
  assert.ok(host.textContent.includes('Get-Content sample.txt'));
  assert.ok(host.textContent.includes('waiting-for-approval'));
  await waitFor(() => !host.querySelector('[aria-label="Message Plex"]').disabled);
  change(host.querySelector('[aria-label="Message Plex"]'), 'What is happening?');
  await waitFor(() => !button('Send').disabled);
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => host.textContent.includes('Plex can answer while the worker waits.'));
  assert.equal(service.snapshot().states[firstId].phase, 'waiting-for-approval');
  assert.equal(button('Approve plan'), undefined);
  await waitFor(() => button('Approve once') && !button('Approve once').disabled);
  button('Approve once').click();
  await waitFor(() => permissionDecisions.length === 1 && host.textContent.includes('synthetic-permission-1') && button('Deny'));
  assert.ok(host.textContent.includes('Approve once: accepted'));
  button('Deny').click();
  await waitFor(() => permissionDecisions.length === 2 && host.textContent.includes('synthetic-permission-2'));
  assert.deepEqual(permissionDecisions, ['approve-once', 'reject']);
  assert.equal(workers, 2, 'decisions must not replace the running worker');
  assert.equal(service.snapshot().states[secondId].phase, 'idle');
  button('Cancel this conversation request').click();
  await waitFor(() => host.textContent.includes('Worker permission request interrupted'));
  assert.equal(service.snapshot().states[secondId].phase, 'idle');
  assert.equal(button('Cancel this conversation request'), undefined);
  permissionMode = false;
  questionMode = true;
  await waitFor(() => !host.querySelector('[aria-label="Message Plex"]').disabled);
  change(host.querySelector('[aria-label="Message Plex"]'), 'Review the environment');
  await waitFor(() => !button('Send').disabled);
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await waitFor(() => button('Approve plan') && !button('Approve plan').disabled);
  button('Approve plan').click();
  await waitFor(() => host.querySelector('[aria-label="Worker question"]') && button('staging'));
  assert.equal(host.querySelector('[aria-label="Answer worker question"]'), null, 'choice-only question must not accept free text');
  button('staging').click();
  await waitFor(() => workerAnswer?.answer === 'staging' && service.snapshot().states[firstId].phase === 'idle');
  assert.equal(host.querySelector('[aria-label="Worker question"]'), null);
  assert.equal(service.snapshot().states[secondId].questions?.length ?? 0, 0);
  reactRoot.unmount();
  service.dispose();
  assert.equal(events.size, 0);
  return { blueprints: true, toolCheckboxes: true, mount: true, multipleChats: true, rejection: true, approval: true,
    results: true, scopedWorkerApproval: true, permissionDecisions: true, permissionCancellation: true, modelPicker: true,
    readonlyWorkerNodeChat: true, nonblockingPlexChat: true, distinctPlan: true, scopedWorkerQuestion: true };
}

async function live(fixture, mode) {
  const { loadSource } = require('./test-support.cjs');
  const { runPlexCli } = loadSource('src/main/plex-cli.ts');
  if (mode === '--live-conversations') {
    const marker = require('node:crypto').randomUUID();
    const req = { cwd: fixture, readOnly: false, schema: {}, signal: new AbortController().signal, conversationHome: path.join(fixture, 'recall') };
    await runPlexCli({ ...req, prompt: `Remember marker ${marker}. Return {"summary":"stored"}.` });
    const result = await runPlexCli({ ...req, prompt: 'Return the exact prior marker as {"summary":"..."} without tools.' });
    assert.equal(result.summary, marker);
    console.log(JSON.stringify({ persistentConversation: true }));
    return;
  }
  if (mode === '--live-tools') {
    const req = { cwd: fixture, readOnly: true, schema: {}, signal: new AbortController().signal };
    const edited = await runPlexCli({ ...req, tools: ['create', 'edit'],
      prompt: 'Use create to create only tool-probe.txt containing exactly initial-probe. Then use edit to replace initial-probe with synthetic-probe. Return {"summary":"done"} after both operations succeed.' });
    assert.ok(fs.existsSync(path.join(fixture, 'tool-probe.txt')), JSON.stringify(edited));
    assert.equal(fs.readFileSync(path.join(fixture, 'tool-probe.txt'), 'utf8').trim(), 'synthetic-probe');
    const result = await runPlexCli({ ...req, tools: ['powershell'],
      prompt: 'Use powershell to read only tool-probe.txt in cwd. Return its exact trimmed content in {"summary":"..."}. Do nothing else.' });
    assert.equal(result.summary, 'synthetic-probe');
    console.log(JSON.stringify({ create: true, edit: true, powershell: true }));
    return;
  }
  const { PlexHarness } = loadSource('src/main/plex-harness.ts');
  let activityEvents = 0;
  const service = new PlexHarness(path.join(fixture, 'plex'), async req => runPlexCli({
    ...req, onActivity: async events => { activityEvents += events.length; await req.onActivity?.(events); },
  }), () => {});
  try {
    service.saveBlueprint({ id: 'synthetic', name: 'Synthetic', revision: 1, agents: [
      { id: 'quality', name: 'dev-quality', description: 'Test coverage review', instructions: '', tools: ['view', 'glob', 'rg'] },
      { id: 'arch', name: 'dev-arch', description: 'Architecture, component boundaries', instructions: '', tools: ['view', 'glob', 'rg'] },
    ] });
    service.createConversation(fixture, 'synthetic', 'synthetic-chat');
    await service.chat('synthetic-chat', 'msg', mode === '--live-routing'
      ? 'Propose one read-only architecture review task for the most suitable agent. Do not execute.'
      : 'Assign exactly one read-only task to dev-arch: read only sample.txt and report the number of widgets with a citation. Do not inspect other directories.');
    const proposed = service.snapshot().states['synthetic-chat'];
    assert.equal(proposed.phase, 'awaiting-approval', proposed.error || JSON.stringify(proposed.messages));
    assert.equal(proposed.tasks.length, 1);
    assert.equal(proposed.agents.find(agent => agent.id === proposed.tasks[0].agentId).name, 'dev-arch');
    if (mode === '--live-routing') { console.log(JSON.stringify({ liveSemanticRouting: true })); return; }
    await service.approve('synthetic-chat', proposed.approvalId);
    const final = service.snapshot().states['synthetic-chat'];
    assert.equal(final.phase, 'idle', final.error);
    assert.equal(final.tasks[0].status, 'completed', JSON.stringify(final.tasks));
    assert.match([final.tasks[0].result.summary, ...final.tasks[0].result.evidence].join(' '), /\b(two|2)\b/i);
    assert.ok(activityEvents > 0);
    assert.ok(service.transcript('synthetic-chat', final.agents.find(agent => agent.name === 'dev-arch').id).entries.length > 0);
    console.log(JSON.stringify({ mountedConversation: true, liveCopilotCoordinator: true, rabbitMQ: true,
      completedResults: 1, synthesis: true, activityEvents, readonlyTranscript: true }));
  } finally {
    service.dispose();
    if (mode === '--live-mission') {
      const connection = await require('amqplib').connect(process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672');
      connection.on('error', () => console.error('Smoke cleanup connection failed'));
      try {
        const { plexQueuePrefix, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts');
        const home = path.join(fixture, 'plex', 'chats', 'synthetic-chat');
        const prefix = plexQueuePrefix(home);
        const channel = await connection.createChannel();
        for (const agent of service.snapshot().states['synthetic-chat'].agents) {
          await channel.deleteQueue(plexWorkerQueue(home, agent.id));
          await channel.deleteQueue(`${plexWorkerQueue(home, agent.id)}.control`);
        }
        await channel.deleteQueue(`${prefix}.results`);
        await channel.deleteQueue(`${prefix}.dead`);
        await channel.deleteExchange(`${prefix}.asks`);
      } finally { await connection.close(); }
    }
  }
}

async function main() {
  if (typeof electron !== 'string') {
    const { app, BrowserWindow } = electron;
    const fixture = process.argv[2];
    app.setPath('userData', path.join(fixture, 'profile'));
    app.disableHardwareAcceleration();
    await app.whenReady();
    const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    try {
      await window.loadURL('about:blank');
      console.log(JSON.stringify(await window.webContents.executeJavaScript(
        `(${testRenderer.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))},${JSON.stringify(fixture)})`)));
      window.destroy(); app.quit();
    } catch (error) { console.error(error); window.destroy(); app.exit(1); }
    return;
  }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-ui-test-'));
  fs.writeFileSync(path.join(fixture, 'sample.txt'), 'The synthetic fixture has two widgets.\n');
  try {
    const mode = process.argv[2];
    if (mode) await live(fixture, mode);
    else {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const run = require('node:child_process').spawnSync(electron, [__filename, fixture], { stdio: 'inherit', env });
      if (run.error) throw run.error;
      assert.equal(run.status, 0);
    }
  } finally { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

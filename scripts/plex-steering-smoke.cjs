// Real Copilot and RabbitMQ; only a synthetic sleep command in a temporary workspace.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadSource } = require('./test-support.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-live-steering-'));
  const marker = `steered-${randomUUID()}`;
  const { PlexHarness } = loadSource('src/main/plex-harness.ts');
  const { runPlexCli } = loadSource('src/main/plex-cli.ts');
  let ready;
  const running = new Promise(resolve => { ready = resolve; });
  let workers = 0;
  const harness = new PlexHarness(path.join(root, 'plex'), async req => {
    const input = JSON.parse(req.prompt);
    if (req.schema.properties.tasks) return { message: 'Synthetic sleep', squadId: null, tasks: [{
      id: 'sleep', title: 'Synthetic sleep', instructions: 'Run only Start-Sleep -Seconds 5 in powershell. Then return a JSON result with summary "initial". Do not read or change files.',
      acceptance: 'Run the synthetic command', dependsOn: [], memberIndex: null, agentId: input.resources.agents[0].id,
    }] };
    if (req.schema.properties.requests) return { message: 'Sending the marker to the live worker.',
      requests: [{ agentId: input.resources.agents[0].id,
        prompt: `Steering: retain your result JSON schema but set the final summary to exactly "${marker}". Do not use additional tools.` }] };
    if (!req.readOnly) return { summary: 'Synthetic mission finished', evidence: [], limitations: [] };
    workers++;
    return runPlexCli({ ...req, onActivity: async events => {
      await req.onActivity(events);
      if (events.some(event => event.kind === 'tool' && event.text.startsWith('powershell'))) ready();
    } });
  }, () => {});
  let mission;
  let timeout;
  try {
    harness.saveBlueprint({ id: 'squad', name: 'Synthetic', revision: 1, agents: [{
      id: 'worker', name: 'Synthetic worker', description: 'Synthetic smoke only', instructions: '', tools: ['powershell'],
    }] });
    harness.createConversation(root, 'squad', 'chat');
    await harness.chat('chat', 'initial', 'Run synthetic command');
    mission = harness.approve('chat', harness.snapshot().states.chat.approvalId);
    await Promise.race([running, mission.then(() => { throw new Error('Worker finished before the steering window'); }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No live worker tool event')), 60000); })]);
    clearTimeout(timeout);
    await harness.chat('chat', 'steering', 'Change the summary marker');
    const receipt = harness.snapshot().states.chat.steering[0];
    assert.equal(receipt.status, 'accepted', JSON.stringify(receipt));
    await mission;
    const state = harness.snapshot().states.chat;
    assert.equal(state.tasks[0].status, 'completed', JSON.stringify(state.tasks[0].result));
    assert.equal(state.tasks[0].result.summary, marker);
    assert.equal(workers, 1);
    const files = fs.readdirSync(path.join(root, 'plex', 'chats', 'chat', 'conversations'));
    const home = path.join(root, 'plex', 'chats', 'chat', 'conversations', files.find(file => file.startsWith('worker-')));
    const identity = JSON.parse(fs.readFileSync(path.join(home, 'plex-conversation.json'), 'utf8'));
    const records = fs.readFileSync(path.join(home, 'session-state', identity.id, 'events.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.type === 'user.message' && record.data.delivery === 'steering' &&
      record.data.messageId === receipt.providerMessageId));
    console.log(JSON.stringify({ realCopilot: true, realRabbitMQ: true, workers, nativeSteering: true,
      deliveryAcknowledged: true, finalAnswerUsedSteering: true }));
  } finally {
    clearTimeout(timeout);
    harness.dispose();
    if (mission) await mission;
    const connection = await require('amqplib').connect(process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672');
    connection.on('error', error => console.error('Smoke cleanup connection failed:', error.message));
    try {
      const { plexQueuePrefix, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts');
      const home = path.join(root, 'plex', 'chats', 'chat');
      const prefix = plexQueuePrefix(home);
      const channel = await connection.createChannel();
      for (const agent of harness.snapshot().states.chat.agents) {
        await channel.deleteQueue(plexWorkerQueue(home, agent.id));
        await channel.deleteQueue(`${plexWorkerQueue(home, agent.id)}.control`);
      }
      await channel.deleteQueue(`${prefix}.results`);
      await channel.deleteQueue(`${prefix}.dead`);
      await channel.deleteExchange(`${prefix}.asks`);
    } finally {
      await connection.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

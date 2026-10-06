// Live SDK worker asks the deterministic test brain for a marker not present in its assignment.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { loadSource } = require('./test-support.cjs');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-autonomy-live-'));
  const { PlexHarness } = loadSource('src/main/plex-harness.ts');
  const { runPlexCli } = loadSource('src/main/plex-cli.ts');
  const marker = randomUUID();
  let workers = 0;
  let questions = 0;
  const service = new PlexHarness(root, async req => {
    const input = JSON.parse(req.prompt);
    if (req.schema.properties.tasks) return { message: 'Ask Plex for a synthetic marker', squadId: null, tasks: [{
      id: 'ask', title: 'Ask Plex', instructions: 'Call ask_user with question "What is the synthetic marker?" and allow freeform input. ' +
        'Do not invent the answer and do not use other tools. After receiving the answer return JSON status completed with summary exactly equal to that answer.',
      acceptance: 'Ask and repeat the returned marker', dependsOn: [], agentId: input.resources.agents[0].id, memberIndex: null,
    }] };
    if (req.schema.properties.questionDecision) {
      questions++;
      return { questionDecision: 'answer', answer: marker, reason: 'Synthetic fixture marker',
        continuation: { scope: 'within-goal', reason: 'No other work needed', tasks: [] } };
    }
    if (!req.readOnly) return { summary: 'Completed', evidence: [], limitations: [],
      continuation: { scope: 'within-goal', reason: 'Goal met', tasks: [] } };
    workers++;
    return runPlexCli(req);
  }, () => {});
  let mission;
  let timer;
  try {
    service.saveBlueprint({ id: 'squad', name: 'Synthetic', revision: 1,
      agents: [{ id: 'reader', name: 'Reader', description: 'Synthetic', instructions: '', tools: ['view'] }] });
    service.createConversation(root, 'squad', 'chat');
    await service.chat('chat', 'initial', 'Ask Plex for a marker');
    mission = service.approve('chat', service.snapshot().states.chat.approvalId);
    await Promise.race([mission, new Promise((_, reject) => {
      timer = setTimeout(() => { service.cancel('chat'); reject(new Error('Autonomy smoke exceeded two minutes')); }, 120000);
    })]);
    const state = service.snapshot().states.chat;
    assert.equal(state.tasks[0].result.summary, marker, JSON.stringify(state.tasks[0].result));
    assert.equal(state.questions[0].answeredBy, 'plex');
    assert.equal(state.questions[0].status, 'answered');
    assert.equal(workers, 1);
    assert.equal(questions, 1);
    console.log(JSON.stringify({ realCopilot: true, realRabbitMQ: true, sdkAskUser: true, sameWorkerResumed: true, autonomousAnswerUsed: true }));
  } finally {
    clearTimeout(timer);
    service.dispose();
    if (mission) await mission;
    const connection = await require('amqplib').connect(process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672');
    connection.on('error', error => console.error('Autonomy smoke cleanup:', error.message));
    try {
      const channel = await connection.createChannel();
      const { plexQueuePrefix, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts');
      const home = path.join(root, 'chats', 'chat');
      for (const agent of service.snapshot().states.chat.agents) {
        await channel.deleteQueue(plexWorkerQueue(home, agent.id));
        await channel.deleteQueue(`${plexWorkerQueue(home, agent.id)}.control`);
      }
      const prefix = plexQueuePrefix(home);
      await channel.deleteQueue(`${prefix}.results`);
      await channel.deleteQueue(`${prefix}.dead`);
      await channel.deleteExchange(`${prefix}.asks`);
    } finally {
      await connection.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { PlexBroker } = loadSource('src/main/plex-broker.ts');
const { createRabbitDispatch, plexQueuePrefix, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-rabbit-smoke-'));
  const broker = new PlexBroker(path.join(root, 'broker.json'));
  const prefix = plexQueuePrefix(root);
  const agents = ['dev-arch', 'dev-quality'].map((name, index) => ({
    id: String(index), name, provider: 'copilot', cwd: root, squadId: 'synthetic', squadName: 'Synthetic', status: 'idle',
  }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  let connected = false;
  try {
    let calls = 0;
    for (const missionId of ['first', 'second']) {
      broker.enqueue(missionId, agents.map((agent, index) => ({
        workerId: agent.id, task: {
          id: `job-${index}`, title: 'Synthetic', instructions: 'Synthetic only', acceptance: 'Return a result',
          dependsOn: index ? ['job-0'] : [], agentId: agent.id, memberIndex: null,
        },
      })));
      await createRabbitDispatch(root)({
        missionId, agents, broker, signal: controller.signal,
        execute: async (agent, job, signal, submit, permission) => {
          connected = true;
          calls++;
          assert.equal(job.workerId, agent.id);
          await permission({ requestId: 'synthetic-permission', status: 'requested', description: 'Synthetic permission event' });
          await permission({ requestId: 'synthetic-permission', status: 'completed' });
          await submit({ status: 'completed', summary: `${missionId}:${agent.name}`, evidence: [], limitations: [] });
        },
      });
      assert.equal(controller.signal.aborted, false, 'RabbitMQ smoke timed out');
      assert.equal(broker.results(missionId).length, 2);
      assert.ok(broker.jobs(missionId).every(job => job.status === 'completed'));
      assert.ok(broker.jobs(missionId).every(job => job.permissions[0].status === 'resolved'));
    }
    assert.equal(calls, 4);
    console.log(JSON.stringify({ realRabbitMQ: true, consumerQueues: 2, missions: 2, acceptedResults: calls, permissionEvents: 8 }));
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (connected) {
      const connection = await require('amqplib').connect(process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672', { timeout: 10_000 });
      connection.on('error', () => console.error('RabbitMQ smoke cleanup connection failed'));
      try {
        const channel = await connection.createChannel();
        for (const agent of agents) await channel.deleteQueue(plexWorkerQueue(root, agent.id));
        await channel.deleteQueue(`${prefix}.results`);
        await channel.deleteQueue(`${prefix}.dead`);
        await channel.deleteExchange(`${prefix}.asks`);
      } finally { await connection.close(); }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });

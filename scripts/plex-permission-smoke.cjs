// Live CLI + RabbitMQ. The SDK wrapper imposes an extra host confirmation on
// synthetic reads, so this test does not depend on the user's managed policy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sdk = require('@github/copilot-sdk');
const { loadSource } = require('./test-support.cjs');

class ConfirmingClient extends sdk.CopilotClient {
  async createSession(options) {
    const session = await super.createSession({
      ...options,
      onPermissionRequest: (permission, invocation) =>
        options.onPermissionRequest({ ...permission, managedApprovalRequired: true }, invocation),
    });
    const on = session.on.bind(session);
    session.on = callback => on(event => callback(event.type === 'permission.requested' ? {
      ...event, data: { ...event.data, permissionRequest: {
        ...event.data.permissionRequest, managedApprovalRequired: true,
      } },
    } : event));
    return session;
  }
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-live-permissions-'));
  const marker = `Synthetic sample file contents: approval smoke marker ${randomUUID()}.`;
  fs.writeFileSync(path.join(root, 'sample.txt'), marker);
  const { PlexHarness } = loadSource('src/main/plex-harness.ts');
  const { runPlexCli } = loadSource('src/main/plex-cli.ts', {
    '@github/copilot-sdk': { ...sdk, CopilotClient: ConfirmingClient },
  });
  let workers = 0;
  let permissionChanged;
  const harness = new PlexHarness(path.join(root, 'plex'), async req => {
    if (req.schema.properties.tasks) return { message: 'Read synthetic file', squadId: null, tasks: [{
      id: 'read', title: 'Read sample', instructions: 'Use view to read sample.txt once. If approved, put the exact file contents in summary. ' +
        'If permission is denied, do not retry or use any other tool; return status blocked with summary "Read denied".',
      acceptance: 'Read sample if allowed; otherwise report denial', dependsOn: [], memberIndex: null,
      agentId: JSON.parse(req.prompt).resources.agents[0].id,
    }] };
    if (!req.readOnly) return { summary: 'Synthetic run finished', evidence: [], limitations: [] };
    workers++;
    return runPlexCli(req);
  }, () => permissionChanged?.());
  const missions = [];
  try {
    harness.saveBlueprint({ id: 'squad', name: 'Synthetic', revision: 1, agents: [{
      id: 'worker', name: 'Reader', description: 'Synthetic file reader', instructions: '', tools: ['view'],
    }] });
    for (const decision of ['approve-once', 'reject']) {
      const chat = decision;
      harness.createConversation(root, 'squad', chat);
      await harness.chat(chat, `initial-${chat}`, 'Read sample.txt');
      let wake;
      let timer;
      let finished = false;
      const receipts = [];
      permissionChanged = () => wake?.();
      const mission = harness.approve(chat, harness.snapshot().states[chat].approvalId);
      missions.push(mission);
      void mission.then(() => { finished = true; wake?.(); });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          harness.cancel(chat);
          reject(new Error(`Live ${decision} mission exceeded two minutes: ${JSON.stringify(harness.snapshot().states[chat].tasks)}`));
        }, 120000);
      });
      void deadline.catch(() => {});
      try {
        while (!finished) {
          const task = harness.snapshot().states[chat].tasks[0];
          const permission = task?.permissions?.find(item => item.status === 'pending' && !item.decision);
          if (permission) {
            assert.ok(receipts.length < 12, 'Unexpected repeated permission requests');
            assert.equal(harness.snapshot().states[chat].phase, 'waiting-for-approval');
            await Promise.race([harness.decidePermission(chat, task.jobId, permission.requestId, decision), deadline]);
            receipts.push(permission.requestId);
            console.log(`${decision}: provider acknowledged permission ${receipts.length}`);
          } else {
            await Promise.race([new Promise(resolve => { wake = resolve; }), mission, deadline]);
          }
        }
        await mission;
      } finally { clearTimeout(timer); }
      assert.ok(receipts.length, 'Worker finished without asking for confirmation');
      const final = harness.snapshot().states[chat].tasks[0];
      for (const requestId of receipts) {
        const receipt = final.permissions.find(item => item.requestId === requestId);
        assert.equal(receipt.decision.status, 'accepted', JSON.stringify(receipt));
        assert.equal(receipt.status, 'resolved');
      }
      assert.equal(final.status, decision === 'approve-once' ? 'completed' : 'blocked', JSON.stringify(final.result));
      assert.equal(final.result.summary, decision === 'approve-once' ? marker : 'Read denied');
    }
    assert.equal(workers, 2, 'each chat uses one worker; no replacement after a decision');
    console.log(JSON.stringify({ realCopilot: true, realRabbitMQ: true, syntheticHostConfirmation: true,
      approveRead: true, denyRead: true, providerDecisionAcknowledged: true, workers }));
  } finally {
    permissionChanged = undefined;
    harness.dispose();
    await Promise.allSettled(missions);
    const connection = await require('amqplib').connect(process.env.PLEX_RABBITMQ_URL || 'amqp://localhost:5672');
    connection.on('error', error => console.error('Smoke cleanup failed:', error.message));
    try {
      const { plexQueuePrefix, plexWorkerQueue } = loadSource('src/main/plex-rabbit.ts');
      const channel = await connection.createChannel();
      for (const [id, state] of Object.entries(harness.snapshot().states)) {
        const home = path.join(root, 'plex', 'chats', id);
        for (const agent of state.agents) {
          await channel.deleteQueue(plexWorkerQueue(home, agent.id));
          await channel.deleteQueue(`${plexWorkerQueue(home, agent.id)}.control`);
        }
        const prefix = plexQueuePrefix(home);
        await channel.deleteQueue(`${prefix}.results`);
        await channel.deleteQueue(`${prefix}.dead`);
        await channel.deleteExchange(`${prefix}.asks`);
      }
    } finally {
      await connection.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

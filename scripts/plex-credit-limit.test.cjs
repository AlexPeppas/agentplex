const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');

test('legacy credit migration clears limits through the provider without a prompt and only once', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-credits-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'plex-conversation.json');
  const original = { id: 'synthetic-id', cwd: home, tools: [], readOnly: false };
  fs.writeFileSync(file, JSON.stringify(original));
  let updates = 0;
  let launches = 0;
  let fail = true;
  const { clearLegacyPlexCreditLimit } = loadSource('src/main/plex-credit-limit.ts', {
    '@github/copilot-sdk': {
      RuntimeConnection: { forStdio: options => options },
      CopilotClient: class {
        constructor() { launches++; }
        async start() {}
        async resumeSession(id, options) {
          assert.equal(id, original.id);
          assert.equal(options.continuePendingWork, false);
          assert.deepEqual(options.availableTools, []);
          return { rpc: { options: { update: async patch => {
            updates++;
            assert.deepEqual(patch, { sessionLimits: null });
            return { success: !fail };
          } } } };
        }
        async stop() { return []; }
        async forceStop() {}
      },
    },
  });
  const migrate = () => clearLegacyPlexCreditLimit(home, original.id, home, 'copilot', 'synthetic', new AbortController().signal);
  await assert.rejects(migrate(), /Cannot clear/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
  fail = false;
  await migrate();
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { ...original, creditLimitCleared: true });
  await migrate();
  assert.equal(updates, 2);
  assert.equal(launches, 2);
});

test('provider session errors preserve the actual diagnostic instead of blaming squad size', () => {
  const { parseCopilotOutput } = loadSource('src/main/plex-cli.ts');
  assert.throws(() => parseCopilotOutput(JSON.stringify({
    type: 'session.error', data: { errorType: 'session_limit', message: 'Session AI credit budget exhausted' },
  })), /session_limit.*Session AI credit budget exhausted/);
  assert.throws(() => parseCopilotOutput('{"type":"session.error"}'), /no diagnostic message/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { loadSource } = require('./test-support.cjs');

test('packaged external worker runtimes load without the repository node_modules', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-packaging-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { default: config } = loadSource('forge.config.ts');
  await config.hooks.packageAfterCopy(config, root);
  const packagedRequire = createRequire(path.join(root, 'package.json'));
  const sdk = packagedRequire('@github/copilot-sdk');
  assert.equal(typeof sdk.CopilotClient, 'function');
  assert.equal(typeof sdk.RuntimeConnection.forStdio, 'function');
  assert.equal(typeof packagedRequire('amqplib').connect, 'function');
  assert.equal(typeof packagedRequire('ws'), 'function');
  assert.ok(fs.existsSync(path.join(root, 'node_modules', 'node-pty', 'package.json')));
  assert.ok(packagedRequire.resolve('@github/copilot-sdk').startsWith(root));
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadSource } = require('./test-support.cjs');
const { JsonlSessionWatcher } = loadSource('src/main/jsonl-session-watcher.ts');
const { ContextMeter } = loadSource('src/renderer/components/SessionMetrics.tsx');
const time = n => new Date(1_700_000_000_000 + n * 1000).toISOString();
const record = (type, data, n = 1) => ({ type, data, timestamp: time(n) });
const checkpoint = (tokens, completed = 2, emitted = completed) => record('session.usage_checkpoint', {
  promptCacheBreakState: [
    { conversation: 'subagent', lastActiveModel: 'other', models: { other: { prompt_tokens: 12, completed_at: time(99) } } },
    { conversation: 'main', lastActiveModel: 'gpt-6-astra', models: {
      'gpt-4o-mini': { prompt_tokens: 166, completed_at: time(99) },
      'gpt-6-astra': { prompt_tokens: tokens, completed_at: time(completed), cache_read: 200000, cache_write: 100 },
    } },
  ],
}, emitted);
const auxiliary = [
  record('model.turn_started', { model: 'gpt-4o-mini', modelInfo: { capabilities: { limits: { max_context_window_tokens: 128000 } } } }),
  record('model.model_call_success', { modelCall: { model: 'gpt-4o-mini' }, responseUsage: { prompt_tokens: 166, completion_tokens: 13 } }),
];

test('background model requests cannot set or overwrite conversation usage or capacity', () => {
  const watcher = new JsonlSessionWatcher('unused', 'copilot');
  const updates = [];
  watcher.on('telemetry', value => updates.push(value));
  const feed = e => watcher.processLine(JSON.stringify(e));
  auxiliary.forEach(feed);
  assert.deepEqual(updates, []);
  feed(record('session.shutdown', { currentTokens: 215271, currentModel: 'gpt-6-astra' }));
  auxiliary.forEach(feed);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].contextTokens, 215271);
  assert.equal(updates[0].contextWindowTokens, null);
  feed(checkpoint(216000));
  assert.equal(updates.at(-1).contextTokens, 216000);
  assert.equal(updates.at(-1).model, 'gpt-6-astra');
  assert.equal(updates.at(-1).updatedAt, Date.parse(time(2)));
});

test('compaction lowers context, rejects stale checkpoints and does not claim a capacity', () => {
  const watcher = new JsonlSessionWatcher('unused', 'copilot');
  const updates = [];
  watcher.on('telemetry', value => updates.push(value));
  const feed = e => watcher.processLine(JSON.stringify(e));
  feed(checkpoint(216000));
  feed(record('session.compaction_complete', { success: false, postCompactionTokens: 0 }, 3));
  assert.equal(updates.length, 1);
  feed(record('session.compaction_complete', { success: true, postCompactionTokens: 35444, tokenLimit: 272000 }, 4));
  feed(checkpoint(216000, 2, 5));
  assert.equal(updates.at(-1).contextTokens, 35444);
  assert.equal(updates.at(-1).contextWindowTokens, null);
  assert.equal(updates.at(-1).model, null);
  feed(checkpoint(40000, 6));
  assert.equal(updates.at(-1).contextTokens, 40000);
  for (const invalid of [null, -1, '999', Infinity]) {
    feed(record('session.shutdown', { currentTokens: invalid }, 7));
  }
  assert.equal(updates.at(-1).contextTokens, 40000);
});

test('restored log tail keeps authoritative snapshot despite newer auxiliary calls', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-token-test-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [checkpoint(207729), record('session.shutdown', { currentTokens: 215271 }, 4), ...auxiliary]
    .map(e => JSON.stringify(e) + '\n').join(''));
  const watcher = new JsonlSessionWatcher(file, 'copilot', true);
  t.after(() => { watcher.stop(); fs.unlinkSync(file); fs.rmdirSync(dir); });
  const updates = [];
  watcher.on('telemetry', value => updates.push(value));
  watcher.start();
  await Promise.resolve();
  assert.equal(updates.at(-1).contextTokens, 215271);
  assert.equal(updates.at(-1).snapshotSource, 'copilot-shutdown');
});

test('header and explorer explicitly label Copilot snapshots without false pressure bars', () => {
  const usage = { snapshotSource: 'copilot-checkpoint', contextTokens: 215271, contextWindowTokens: null,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, updatedAt: Date.parse(time(2)), model: 'gpt-6-astra' };
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(ContextMeter, { usage, compact }));
    assert.match(html, /215k/);
    assert.match(html, /snapshot/);
    assert.match(html, /not live \/context usage/);
    assert.doesNotMatch(html, /width:|gpt-6-astra|Input 0/);
  }
});

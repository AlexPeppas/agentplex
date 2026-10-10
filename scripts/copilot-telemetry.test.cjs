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
    assert.match(html, /prompt/);
    assert.match(html, /not live \/context usage/);
    assert.doesNotMatch(html, /width:|gpt-6-astra|Input 0/);
  }
});

const usageRecord = (tokens, n, sourceSessionId = 'main-session', extra = {}) => record('session.usage_record', {
  usage: { model: 'gpt-6.1-sol', interactionType: 'conversation-agent',
    inputTokens: tokens, outputTokens: 588, cacheReadTokens: 100000, cacheWriteTokens: 500,
    accounting: { sourceSessionId }, ...extra },
}, n);

test('durable main-session usage records refresh sparse checkpoints without adding cache or output tokens to context', () => {
  const watcher = new JsonlSessionWatcher(path.join('main-session', 'events.jsonl'), 'copilot');
  const updates = [];
  watcher.on('telemetry', usage => updates.push(usage));
  const feed = e => watcher.processLine(JSON.stringify(e));
  feed(checkpoint(107000));
  feed(usageRecord(119000, 3));
  assert.equal(updates.at(-1).contextTokens, 119000);
  assert.equal(updates.at(-1).inputTokens, 18500);
  assert.equal(updates.at(-1).outputTokens, 588);
  assert.equal(updates.at(-1).snapshotSource, 'copilot-usage');
  assert.equal(updates.at(-1).contextWindowTokens, null);
  feed(checkpoint(107000, 2, 4));
  assert.equal(updates.at(-1).contextTokens, 119000);
  feed(usageRecord(120000, 5));
  assert.equal(updates.at(-1).contextTokens, 120000);
});

test('child, auxiliary, malformed and stale durable usage records cannot replace the main prompt', () => {
  const watcher = new JsonlSessionWatcher(path.join('main-session', 'events.jsonl'), 'copilot');
  const updates = [];
  watcher.on('telemetry', usage => updates.push(usage));
  const feed = e => watcher.processLine(JSON.stringify(e));
  feed(usageRecord(119000, 3));
  feed(usageRecord(400, 4, 'child-session'));
  feed({ ...usageRecord(400, 4), agentId: 'child-agent' });
  feed(usageRecord(400, 4, 'main-session', { interactionType: 'title-generation' }));
  feed(usageRecord(400, 4, 'main-session', { accounting: {} }));
  feed(usageRecord(400, 4, 'main-session', { inputTokens: '400' }));
  feed(usageRecord(400, 4, 'main-session', { outputTokens: -1 }));
  feed(usageRecord(400, 2));
  feed({ ...checkpoint(400, 5), agentId: 'child-agent' });
  assert.equal(updates.length, 1);
  feed(record('session.compaction_start', { currentTokens: 130000, tokenLimit: 272000 }, 5));
  assert.equal(updates.at(-1).contextTokens, 130000);
  assert.equal(updates.at(-1).snapshotSource, 'copilot-compaction-start');
  assert.equal(updates.at(-1).contextWindowTokens, null);
  feed(record('session.compaction_complete', { success: true, postCompactionTokens: 30000 }, 6));
  feed(usageRecord(119000, 3));
  assert.equal(updates.at(-1).contextTokens, 30000);
  feed(usageRecord(31000, 7));
  assert.equal(updates.at(-1).contextTokens, 31000);
});

test('restore and incremental events.jsonl polling use current durable usage records, including split appends', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-durable-usage-'));
  const sessionId = path.basename(dir);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [checkpoint(107000), usageRecord(119000, 3, sessionId), checkpoint(107000, 2, 4)]
    .map(e => JSON.stringify(e) + '\n').join(''));
  const watcher = new JsonlSessionWatcher(file, 'copilot', true);
  t.after(() => { watcher.stop(); fs.unlinkSync(file); fs.rmdirSync(dir); });
  const updates = [];
  watcher.on('telemetry', usage => updates.push(usage));
  watcher.start();
  await Promise.resolve();
  assert.equal(updates.at(-1).contextTokens, 119000);
  const live = JSON.stringify(usageRecord(121000, 5, sessionId)) + '\n';
  fs.appendFileSync(file, live.slice(0, 50));
  watcher.poll();
  assert.equal(updates.at(-1).contextTokens, 119000);
  fs.appendFileSync(file, live.slice(50));
  watcher.poll();
  assert.equal(updates.at(-1).contextTokens, 121000);
  assert.equal(updates.at(-1).updatedAt, Date.parse(time(5)));
});

test('header and explorer distinguish a durable last prompt from exact context snapshots', () => {
  const watcher = new JsonlSessionWatcher(path.join('main-session', 'events.jsonl'), 'copilot');
  let usage;
  watcher.on('telemetry', value => { usage = value; });
  watcher.processLine(JSON.stringify(usageRecord(119000, 3)));
  for (const compact of [true, false]) {
    const html = renderToStaticMarkup(React.createElement(ContextMeter, { usage, compact }));
    assert.match(html, /119k/);
    assert.match(html, /prompt/);
    assert.match(html, /not live \/context usage/);
    assert.doesNotMatch(html, /width:|44%/);
  }
  watcher.processLine(JSON.stringify(record('session.compaction_start', { currentTokens: 130000 }, 5)));
  const html = renderToStaticMarkup(React.createElement(ContextMeter, { usage }));
  assert.match(html, /Context before compaction/);
  assert.match(html, /snapshot/);
});

test('managed session header receives restored and newly appended durable usage through IPC', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-usage-ipc-'));
  const uuid = '11111111-1111-4111-8111-111111111111';
  const file = path.join(home, '.copilot', 'session-state', uuid, 'events.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(usageRecord(119000, 3, uuid)) + '\n');
  const updates = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    os: { ...os, homedir: () => home }, electron: {},
    'node-pty': { spawn: () => ({ pid: 123, onData() {}, onExit() {}, write() {}, kill() {} }) },
    './shell-detector': { getShellById: () => ({ path: 'synthetic-shell' }) },
    './settings-manager': { getDefaultShellId: () => 'synthetic-shell' },
    './copilot-session-scanner': { renderCopilotTranscript: () => '' },
  });
  const manager = new SessionManager();
  manager.setWindow({ isDestroyed: () => false, webContents: { send: (channel, data) => {
    if (channel === 'session:infoUpdate') updates.push(data);
  } } });
  t.after(() => {
    manager.stop();
    t.mock.timers.reset();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const info = manager.create(home, 'copilot', uuid);
  await Promise.resolve();
  assert.equal(manager.list()[0].usage.contextTokens, 119000);
  fs.appendFileSync(file, JSON.stringify(usageRecord(121000, 5, uuid)) + '\n');
  manager.sessions.get(info.id).jsonlWatcher.poll();
  assert.equal(manager.list()[0].usage.contextTokens, 121000);
  assert.equal(updates.at(-1).id, info.id);
  assert.equal(updates.at(-1).usage.snapshotSource, 'copilot-usage');
  assert.equal(updates.at(-1).usage.contextTokens, 121000);
});

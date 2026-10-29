const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { JsonlSessionWatcher } = loadSource('src/main/jsonl-session-watcher.ts');
const event = (type, data) => ({ type, data });
const start = (id, query) => event('tool.execution_start', { toolCallId: id, toolName: 'sql', arguments: { query } });
const done = (id, success = true) => event('tool.execution_complete', { toolCallId: id, success });
const seed = "INSERT INTO todos (id,title,status) VALUES ('a','Original','pending')";
const feed = (watcher, ...records) => records.forEach(record => watcher.processLine(JSON.stringify(record)));

test('SQL tasks commit on success only and match SQLite statement order, literals and optional terminators', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT, status TEXT)');
  const watcher = new JsonlSessionWatcher('unused', 'copilot');
  const updates = [];
  watcher.on('task-list', e => updates.push(e.tasks));
  const queries = [
    seed,
    "DELETE FROM todos; INSERT INTO todos (id,title,status) VALUES ('b','It''s a; task -- not a comment','pending'); UPDATE todos SET status='done' WHERE id='b'",
    "/* DELETE FROM todos; */ INSERT INTO todos (id,title,status) VALUES ('c','Other','pending'); -- UPDATE todos SET status='done';\nUPDATE todos SET status='in_progress' WHERE id='c'; DELETE FROM todos WHERE id='b'",
    'DELETE FROM todos',
    seed,
  ];
  try {
    queries.forEach((query, i) => {
      const count = updates.length;
      feed(watcher, start(String(i), query));
      assert.equal(updates.length, count, 'no speculative mutations');
      db.exec(query);
      feed(watcher, done(String(i)));
      assert.deepEqual(updates.at(-1).map(t => ({ title: t.description, status: t.status })),
        db.prepare('SELECT title,status FROM todos ORDER BY rowid').all().map(row => ({
          title: row.title, status: row.status === 'done' ? 'completed' : row.status,
        })));
    });
    const count = updates.length;
    feed(watcher, start('bad', 'DELETE FROM todos'), done('bad', false));
    feed(watcher, start('missing', 'DELETE FROM todos'), event('tool.execution_complete', { toolCallId: 'missing' }));
    assert.equal(updates.length, count);
    assert.equal(watcher.getCopilotTaskList()[0].description, 'Original');
  } finally { db.close(); }
});

test('resume hydrates identities beyond telemetry tail without historical UI actions and retains pending completions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-tasks-'));
  const file = path.join(root, 'events.jsonl');
  const pending = "INSERT INTO todos (id,title,status) VALUES ('b','Pending completion','pending')";
  fs.writeFileSync(file, [start('seed', seed), done('seed'),
    event('subagent.started', { toolCallId: 'old-agent' }),
    event('session.plan_changed', { operation: 'create' }),
    event('ignored', { filler: 'x'.repeat(2 * 1024 * 1024) }),
    start('pending', pending)].map(e => JSON.stringify(e) + '\n').join(''));
  const watcher = new JsonlSessionWatcher(file, 'copilot', true);
  t.after(() => { watcher.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const updates = [], actions = [];
  watcher.on('task-list', e => updates.push(e.tasks));
  watcher.on('agent-spawn', e => actions.push(e));
  watcher.on('plan-changed', e => actions.push(e));
  watcher.start();
  await watcher.ready;
  assert.deepEqual(actions, []);
  assert.deepEqual(updates.at(-1), [{ taskNumber: 1, description: 'Original', status: 'pending' }]);
  fs.appendFileSync(file, [done('pending'), start('update', "UPDATE todos SET status='done' WHERE id='a'"),
    done('update')].map(e => JSON.stringify(e) + '\n').join(''));
  watcher.poll();
  assert.deepEqual(updates.at(-1), [
    { taskNumber: 1, description: 'Original', status: 'completed' },
    { taskNumber: 2, description: 'Pending completion', status: 'pending' },
  ]);
  fs.appendFileSync(file, [start('delete', "DELETE FROM todos WHERE id='a'"), done('delete')]
    .map(e => JSON.stringify(e) + '\n').join(''));
  watcher.poll();
  assert.equal(updates.at(-1).length, 1);
  assert.equal(updates.at(-1)[0].taskNumber, 2);
});

test('full-history hydration yields, freezes its snapshot and orders live SQL after restored tasks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-task-yield-'));
  const file = path.join(root, 'events.jsonl');
  const filler = JSON.stringify(event('ignored', { text: 'x'.repeat(4096) })) + '\n';
  fs.writeFileSync(file, JSON.stringify(start('seed', seed)) + '\n' + JSON.stringify(done('seed')) + '\n' + filler.repeat(4096));
  let release, entered, first = true, ticks = 0, closed = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const reading = new Promise(resolve => { entered = resolve; });
  const { JsonlSessionWatcher: Watcher } = loadSource('src/main/jsonl-session-watcher.ts', {
    fs: { ...fs, promises: { ...fs.promises, async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        stat: () => handle.stat(),
        async read(...rest) {
          if (first) { first = false; entered(); await gate; }
          return handle.read(...rest);
        },
        async close() { closed++; await handle.close(); },
      };
    } } },
  });
  const watcher = new Watcher(file, 'copilot', true);
  const updates = [];
  watcher.on('task-list', value => updates.push(value.tasks));
  const heartbeat = setInterval(() => { ticks++; }, 1);
  t.after(async () => {
    release(); watcher.stop(); await watcher.ready; clearInterval(heartbeat);
    fs.rmSync(root, { recursive: true, force: true });
  });
  watcher.start();
  await reading;
  const snapshot = watcher.snapshotOffset;
  fs.appendFileSync(file, [start('live', "UPDATE todos SET status='done' WHERE id='a'"), done('live')]
    .map(value => JSON.stringify(value) + '\n').join(''));
  watcher.poll();
  assert.equal(watcher.snapshotOffset, snapshot, 'live polling must wait for task identities');
  assert.deepEqual(updates, []);
  release();
  await watcher.ready;
  assert.ok(ticks > 0, 'event-loop timers run while a large history is reconstructed');
  assert.equal(closed, 1);
  assert.equal(updates.at(-1)[0].status, 'pending', 'appends are outside the frozen startup snapshot');
  watcher.poll();
  assert.equal(updates.at(-1)[0].status, 'completed');
});

test('stopping hydration closes its read handle without late events and a restart can reconstruct normally', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-task-cancel-'));
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, [start('seed', seed), done('seed')].map(value => JSON.stringify(value) + '\n').join(''));
  let release, entered, closed = 0, paused = true;
  const reading = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { JsonlSessionWatcher: Watcher } = loadSource('src/main/jsonl-session-watcher.ts', {
    fs: { ...fs, promises: { ...fs.promises, async open(...args) {
      const handle = await fs.promises.open(...args);
      return {
        stat: () => handle.stat(),
        async read(...rest) { if (paused) { entered(); await gate; } return handle.read(...rest); },
        async close() { closed++; await handle.close(); },
      };
    } } },
  });
  const watcher = new Watcher(file, 'copilot', true);
  const events = [];
  for (const type of ['task-list', 'telemetry', 'lifecycle', 'watch-error']) watcher.on(type, value => events.push([type, value]));
  t.after(async () => { release(); watcher.stop(); await watcher.ready; fs.rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  await reading;
  watcher.stop();
  release();
  await watcher.ready;
  assert.equal(closed, 1);
  assert.deepEqual(events, []);
  paused = false;
  watcher.start();
  await watcher.ready;
  assert.equal(watcher.getCopilotTaskList()[0].description, 'Original');
  assert.equal(closed, 2);
});

test('hydration failures surface explicitly and a complete record without its newline remains live-only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-task-boundary-'));
  const file = path.join(root, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify(start('seed', seed)) + '\n' + JSON.stringify(done('seed')));
  const watcher = new JsonlSessionWatcher(file, 'copilot', true);
  t.after(async () => { watcher.stop(); await watcher.ready; fs.rmSync(root, { recursive: true, force: true }); });
  watcher.start();
  await watcher.ready;
  assert.deepEqual(watcher.getCopilotTaskList(), []);
  fs.appendFileSync(file, '\n');
  watcher.poll();
  assert.equal(watcher.getCopilotTaskList()[0].description, 'Original');
  const failure = Object.assign(new Error('synthetic hydration access denied'), { code: 'EACCES' });
  const { JsonlSessionWatcher: Failing } = loadSource('src/main/jsonl-session-watcher.ts', {
    fs: { ...fs, promises: { ...fs.promises, open: async () => { throw failure; } } },
  });
  const failing = new Failing(file, 'copilot', true);
  let reported;
  failing.on('watch-error', error => { reported = error; });
  failing.start();
  await failing.ready;
  assert.equal(reported, failure);
  assert.equal(failing.timer, null);
});

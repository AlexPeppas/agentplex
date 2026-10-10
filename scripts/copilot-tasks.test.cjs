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
  await Promise.resolve();
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

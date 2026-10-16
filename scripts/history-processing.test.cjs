const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');
const { loadSource } = require('./test-support.cjs');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let bytes = 0, closed = 0;
  const trackedFs = { ...fs, promises: { ...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {
      stat: () => handle.stat(),
      read: async (...readArgs) => {
        const result = await handle.read(...readArgs);
        if (String(args[0]).endsWith('.jsonl')) bytes += result.bytesRead;
        return result;
      },
      close: async () => { closed++; await handle.close(); },
    };
  } }, readFileSync: (file, ...args) => {
    assert.ok(!String(file).endsWith('.jsonl'), 'history must never use whole-file synchronous reads');
    return fs.readFileSync(file, ...args);
  }, readSync: () => assert.fail('history must never use synchronous reads') };
  const overrides = { fs: trackedFs, os: { ...os, homedir: () => home } };
  return { home, overrides, counters: () => ({ bytes, closed }), reset: () => { bytes = 0; closed = 0; } };
}

test('bounded JSONL reads preserve split UTF-8, partial-tail boundaries and a frozen file size', async t => {
  const f = fixture(t);
  const file = path.join(f.home, 'events.jsonl');
  const text = 'a'.repeat(65533) + '漢🚀' + '\nsecond\nthird';
  fs.writeFileSync(file, text);
  const { readHistoryLines } = loadSource('src/main/history-reader.ts', f.overrides);
  assert.deepEqual(await Array.fromAsync(readHistoryLines(file, 200000)), text.split('\n'));
  assert.deepEqual(await Array.fromAsync(readHistoryLines(file, 9, true)), ['third']);
  assert.deepEqual(await Array.fromAsync(readHistoryLines(file, 12, true)), ['second', 'third']);
  const iterator = readHistoryLines(file, 200000);
  const first = await iterator.next();
  fs.appendFileSync(file, '\nnot-in-original-snapshot\n');
  assert.deepEqual([first.value, ...await Array.fromAsync(iterator)], text.split('\n'));
  assert.equal(f.counters().closed, 4);
});

test('bounded readers release handles on early exit, cancellation and read failure', async t => {
  const f = fixture(t), file = path.join(f.home, 'events.jsonl');
  fs.writeFileSync(file, 'first\nsecond\n');
  const { readHistoryLines } = loadSource('src/main/history-reader.ts', f.overrides);
  for await (const line of readHistoryLines(file, 100)) { assert.equal(line, 'first'); break; }
  const controller = new AbortController();
  const iterator = readHistoryLines(file, 100, false, controller.signal);
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(f.counters().closed, 2);
  let closed = false;
  const failing = loadSource('src/main/history-reader.ts', { fs: { promises: { open: async () => ({
    stat: async () => ({ size: 10 }), read: async () => { throw new Error('synthetic disk failure'); },
    close: async () => { closed = true; },
  }) } } });
  await assert.rejects(Array.fromAsync(failing.readHistoryLines(file, 100)), /synthetic disk failure/);
  assert.equal(closed, true);
});

async function measure(operation) {
  let last = performance.now(), maxGap = 0, ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    ticks++;
  }, 5);
  try {
    const value = await operation();
    await new Promise(resolve => setTimeout(resolve, 10));
    return { value, maxGap, ticks };
  } finally { clearInterval(timer); }
}

test('large Copilot histories stay bounded and responsive across resume scanning, search and external discovery', async t => {
  const f = fixture(t), project = path.join(f.home, 'project');
  fs.mkdirSync(project);
  const body = Buffer.from((JSON.stringify({
    type: 'assistant.message', data: { content: 'x'.repeat(8192) },
  }) + '\n').repeat(1024));
  const ids = [];
  for (let i = 0; i < 12; i++) {
    const id = `${String(i + 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
    ids.push(id);
    const dir = path.join(f.home, '.copilot', 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `cwd: ${project}\n`);
    const timestamp = new Date(Date.UTC(2026, 0, i + 1)).toISOString();
    const file = path.join(dir, 'events.jsonl');
    const fd = fs.openSync(file, 'w');
    try {
      fs.writeSync(fd, JSON.stringify({ type: 'session.start', timestamp,
        data: { title: `Title ${i}`, context: { cwd: project, branch: 'feature' }, startTime: timestamp } }) + '\n');
      fs.writeSync(fd, JSON.stringify({ type: 'user.message', timestamp, data: { content: 'First question' } }) + '\n');
      fs.writeSync(fd, body);
      fs.writeSync(fd, Array.from({ length: 8 }, () => JSON.stringify({
        type: 'user.message', timestamp, data: { content: 'SYNTHETIC_NEEDLE 漢🚀 final message' },
      })).join('\n') + '\n');
    } finally { fs.closeSync(fd); }
    fs.utimesSync(file, new Date(timestamp), new Date(timestamp));
  }
  const scanner = loadSource('src/main/copilot-session-scanner.ts', f.overrides);
  const scan = await measure(() => scanner.scanSessionsForProject(project));
  assert.deepEqual(scan.value.map(s => s.sessionId), [...ids].reverse());
  assert.equal(scan.value[0].firstUserMessage, 'First question');
  assert.equal(scan.value[0].customTitle, 'Title 11');
  assert.equal(scan.value[0].gitBranch, 'feature');
  assert.ok(f.counters().bytes <= 12 * (128 * 1024 + 1), 'metadata reads only bounded head and tail');
  f.reset();
  const search = loadSource('src/main/session-search.ts', f.overrides);
  const found = await measure(() => search.searchSessions('synthetic_needle'));
  assert.equal(found.value.length, 60, 'five matches per session, with the existing result shape');
  assert.equal(found.value[0].sessionId, ids.at(-1));
  assert.ok(found.value.every(r => r.projectPath === project && r.snippet.includes('漢🚀')));
  assert.ok(f.counters().bytes <= 12 * (4 * 1024 * 1024 + 1));
  assert.ok(found.ticks > 3, 'history parsing lets main-process timers run throughout');
  assert.ok(found.maxGap < 75, `search blocked the event loop for ${found.maxGap.toFixed(1)}ms`);
  const cancelled = new AbortController();
  const cancelTimer = setTimeout(() => cancelled.abort(), 5);
  try {
    await assert.rejects(search.searchSessions('missing needle', cancelled.signal), { name: 'AbortError' });
  } finally { clearTimeout(cancelTimer); }
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const { SessionManager } = loadSource('src/main/session-manager.ts', {
      ...f.overrides, electron: {}, 'node-pty': {}, './shell-detector': {}, './settings-manager': {},
      './config-loader': {}, './plan-task-detector': {},
    });
    f.reset();
    const external = await measure(() => new SessionManager().discoverExternal());
    assert.equal(external.value.length, 12);
    assert.ok(f.counters().bytes <= 12 * (128 * 1024 + 1));
    t.diagnostic(`96 MiB histories: scan max gap ${scan.maxGap.toFixed(1)}ms; search ${found.maxGap.toFixed(1)}ms; discovery ${external.maxGap.toFixed(1)}ms`);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('resume scans cap metadata work before opening older logs and honor cancellation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 55; i++) {
    const dir = path.join(f.home, '.copilot', 'session-state', `session-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), `cwd: ${f.home}\n`);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
      type: 'user.message', timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), data: { content: 'question' },
    }) + '\n');
    const time = new Date(Date.UTC(2026, 0, i + 1));
    fs.utimesSync(path.join(dir, 'events.jsonl'), time, time);
  }
  const scanner = loadSource('src/main/copilot-session-scanner.ts', f.overrides);
  const sessions = await scanner.scanSessionsForProject(f.home);
  assert.equal(sessions.length, 50);
  assert.equal(sessions[0].sessionId, 'session-54');
  assert.ok(!sessions.some(s => s.sessionId === 'session-0'));
  assert.equal(f.counters().closed, 55 + 50 * 2);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(scanner.scanSessionsForProject(f.home, controller.signal), { name: 'AbortError' });
  const search = loadSource('src/main/session-search.ts', f.overrides);
  await assert.rejects(search.searchSessions('question', controller.signal), { name: 'AbortError' });
});

test('Claude bounded async previews preserve metadata, text-block search and tail timestamps', async t => {
  const f = fixture(t), projectDir = path.join(f.home, '.claude', 'projects', 'encoded');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'claude-session.jsonl'), [
    { type: 'custom-title', customTitle: 'Claude title', cwd: f.home },
    { type: 'user', cwd: f.home, gitBranch: 'feature', timestamp: '2026-01-01T00:00:00Z', message: { content: 'First question' } },
    { type: 'assistant', timestamp: '2026-01-02T00:00:00Z', message: { content: [{ type: 'text', text: 'Searchable answer' }] } },
  ].map(JSON.stringify).join('\n'));
  const scanner = loadSource('src/main/claude-session-scanner.ts', f.overrides);
  const [session] = await scanner.scanSessionsForProject('encoded');
  assert.equal(session.customTitle, 'Claude title');
  assert.equal(session.firstUserMessage, 'First question');
  assert.equal(session.gitBranch, 'feature');
  assert.equal(session.lastTimestamp, '2026-01-02T00:00:00Z');
  const search = loadSource('src/main/session-search.ts', f.overrides);
  const [result] = await search.searchSessions('searchable');
  assert.equal(result.role, 'assistant');
  assert.equal(result.sessionId, 'claude-session');
});

test('history IPC isolates cancellation by window and scope, and propagates real failures', async t => {
  const { IPC } = loadSource('src/shared/ipc-channels.ts');
  const handlers = new Map(), listeners = new Map(), pending = [];
  const operation = (query, signal) => query === 'failure'
    ? Promise.reject(new Error('Synthetic history disk failure'))
    : new Promise((resolve, reject) => {
    pending.push({ signal, resolve });
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  loadSource('src/main/ipc-handlers.ts', {
    electron: { app: { getPath: () => os.tmpdir() },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => listeners.set(name, fn) } },
    './session-search': { searchSessions: operation },
    './claude-session-scanner': { scanProjects: signal => operation(null, signal) },
    './copilot-session-scanner': {}, './session-manager': {}, './shell-detector': {},
    './settings-manager': {}, './config-loader': {}, './git-operations': {}, './copilot-summary-proxy': {},
  }).registerIpcHandlers();
  const first = Object.assign(new EventEmitter(), { id: 1 });
  const second = Object.assign(new EventEmitter(), { id: 2 });
  const search = (sender, query) => handlers.get(IPC.SESSION_SEARCH)({ sender }, { query });
  const old = search(first, 'old');
  const otherWindow = search(second, 'other');
  const latest = search(first, 'new');
  const projects = handlers.get(IPC.LAUNCHER_SCAN_PROJECTS)({ sender: first }, {});
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  listeners.get(IPC.HISTORY_CANCEL)({ sender: first }, { kind: 'search' });
  assert.equal(pending[2].signal.aborted, true);
  assert.equal(pending[3].signal.aborted, false);
  pending[1].resolve(['other result']);
  first.emit('destroyed');
  assert.deepEqual(await Promise.all([old, otherWindow, latest, projects]), [[], ['other result'], [], []]);
  assert.equal(first.listenerCount('destroyed'), 0);
  assert.equal(second.listenerCount('destroyed'), 0);
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  await assert.rejects(search(second, 'failure'), /Synthetic history disk failure/);
  assert.equal(errors.length, 1);
  assert.equal(second.listenerCount('destroyed'), 0);
});

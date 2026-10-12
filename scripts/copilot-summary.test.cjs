const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');

function proxyFixture(t, options = {}) {
  const keys = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'AGENTPLEX_API_KEY', 'COPILOT_CLI_PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  keys.forEach(key => delete process.env[key]);
  process.env.GH_TOKEN = 'synthetic-github-token';
  process.env.AGENTPLEX_API_KEY = 'synthetic-anthropic-key';
  process.env.COPILOT_CLI_PATH = path.join(os.tmpdir(), options.jsCli ? 'synthetic-copilot.js' : 'synthetic-copilot.exe');
  t.after(() => keys.forEach(key => {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }));
  const clients = [], sessions = [], requests = [];
  const models = options.models || [
    { id: 'claude-sonnet-4.5', billing: { multiplier: 1 } },
    { id: 'gpt-4.1', billing: { multiplier: 0 }, policy: { state: 'enabled' } },
    { id: 'claude-haiku-4.5', billing: { multiplier: 0.33 } },
    { id: 'disabled', billing: { multiplier: 0 }, policy: { state: 'disabled' } },
  ];
  const proxy = loadSource('src/main/copilot-summary-proxy.ts', {
    'node:fs': {
      ...fs,
      existsSync: candidate => !options.missingCli && candidate === process.env.COPILOT_CLI_PATH,
      realpathSync: candidate => candidate,
    },
    '@github/copilot-sdk': {
      RuntimeConnection: { forStdio: value => value },
      CopilotClient: class {
        constructor(config) { this.config = config; this.stops = 0; clients.push(this); }
        async start() { if (options.startError) throw options.startError; }
        async listModels() { return models; }
        async createSession(config) {
          sessions.push(config);
          return {
            sendAndWait: async (request, timeout) => {
              requests.push({ request, timeout });
              if (options.sendError) throw options.sendError;
              if (options.send) return options.send();
              return { data: { content: options.answer ?? '  Synthetic summary  ' } };
            },
          };
        }
        async forceStop() { this.stops++; options.stop?.(); }
      },
    },
    'node:child_process': {
      execFile(_file, _args, _options, callback) {
        if (options.ghToken) callback(null, { stdout: options.ghToken });
        else callback(new Error('Synthetic missing GitHub login'));
      },
    },
  });
  return { proxy, clients, sessions, requests };
}

test('Copilot proxy authenticates through GitHub, uses an enabled low-cost model, forbids tools and cleans its isolated runtime', async t => {
  const f = proxyFixture(t);
  const result = await f.proxy.summarizeWithCopilot('Summarize synthetic conversation');
  assert.deepEqual(result, { summary: 'Synthetic summary', model: 'gpt-4.1' });
  assert.equal(f.clients[0].config.gitHubToken, 'synthetic-github-token');
  assert.equal(f.clients[0].config.useLoggedInUser, false);
  assert.equal(f.clients[0].config.env.AGENTPLEX_API_KEY, undefined);
  assert.ok(f.clients[0].config.connection.args.includes('--no-custom-instructions'));
  assert.ok(f.clients[0].config.connection.args.includes('--disable-builtin-mcps'));
  assert.deepEqual(f.sessions[0].availableTools, []);
  assert.deepEqual(f.sessions[0].tools, []);
  assert.equal(f.sessions[0].skipCustomInstructions, true);
  assert.equal(f.sessions[0].onPermissionRequest({ kind: 'shell' }).kind, 'reject');
  assert.equal(f.sessions[0].remoteSession, 'off');
  assert.equal(f.requests[0].request.prompt, 'Summarize synthetic conversation');
  assert.equal(f.clients[0].stops, 1);
  assert.equal(fs.existsSync(f.clients[0].config.baseDirectory), false);
});

test('proxy failures and unavailable models are explicit and still stop and clean owned runtimes', async t => {
  for (const options of [
    { startError: new Error('Synthetic startup failure') },
    { sendError: new Error('Synthetic inference failure') },
    { models: [{ id: 'blocked', policy: { state: 'disabled' } }] },
    { answer: '' },
  ]) {
    const f = proxyFixture(t, options);
    await assert.rejects(f.proxy.summarizeWithCopilot('Synthetic conversation'));
    assert.equal(f.clients[0].stops, 1);
    assert.equal(fs.existsSync(f.clients[0].config.baseDirectory), false);
  }
});

test('missing GitHub authentication cannot fall back to an Anthropic key or start a runtime', async t => {
  const f = proxyFixture(t);
  delete process.env.GH_TOKEN;
  await assert.rejects(f.proxy.summarizeWithCopilot('Synthetic conversation'), /gh auth login/);
  assert.equal(f.clients.length, 0);
});

test('GitHub CLI authentication works without token environment variables', async t => {
  const f = proxyFixture(t, { ghToken: 'synthetic-gh-login\n' });
  delete process.env.GH_TOKEN;
  await f.proxy.summarizeWithCopilot('Synthetic conversation');
  assert.equal(f.clients[0].config.gitHubToken, 'synthetic-gh-login');
});

test('CLI resolution uses absolute JavaScript entrypoints with Electron node mode, and reports missing installations', async t => {
  const js = proxyFixture(t, { jsCli: true });
  await js.proxy.summarizeWithCopilot('Synthetic conversation');
  assert.equal(js.clients[0].config.connection.path, process.env.COPILOT_CLI_PATH);
  assert.equal(js.clients[0].config.env.ELECTRON_RUN_AS_NODE, '1');
  const missing = proxyFixture(t, { missingCli: true });
  await assert.rejects(missing.proxy.summarizeWithCopilot('Synthetic conversation'), /Copilot CLI not found/);
  assert.equal(missing.clients.length, 0);
});

test('model selection skips a cheaper model whose advertised context cannot hold the conversation', async t => {
  const f = proxyFixture(t, { models: [
    { id: 'small', billing: { multiplier: 0 }, capabilities: { limits: { max_context_window_tokens: 4096 } } },
    { id: 'unconfigured', policy: { state: 'unconfigured' }, billing: { multiplier: 0 },
      capabilities: { limits: { max_context_window_tokens: 128000 } } },
    { id: 'large', billing: { multiplier: 1 }, capabilities: { limits: { max_context_window_tokens: 128000 } } },
  ] });
  assert.equal((await f.proxy.summarizeWithCopilot('x'.repeat(10000))).model, 'large');
});

test('shutdown rejects active inference, waits for profile cleanup and prevents new runtimes', async t => {
  let rejectSend;
  const f = proxyFixture(t, {
    send: () => new Promise((_resolve, reject) => { rejectSend = reject; }),
    stop: () => rejectSend?.(new Error('Synthetic runtime stopped')),
  });
  const request = f.proxy.summarizeWithCopilot('Synthetic conversation');
  const rejected = assert.rejects(request, /shutting down/);
  for (let i = 0; i < 20 && !f.requests.length; i++) await Promise.resolve();
  assert.equal(f.requests.length, 1);
  await f.proxy.stopCopilotSummaries();
  await rejected;
  assert.equal(f.clients[0].stops, 1);
  assert.equal(fs.existsSync(f.clients[0].config.baseDirectory), false);
  await assert.rejects(f.proxy.summarizeWithCopilot('Later request'), /shutting down/);
  assert.equal(f.clients.length, 1);
});

test('summary timeout force-stops the runtime, cleans its profile and rejects the request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rejectSend;
  const f = proxyFixture(t, {
    send: () => new Promise((_resolve, reject) => { rejectSend = reject; }),
    stop: () => rejectSend?.(new Error('Synthetic runtime stopped')),
  });
  const result = f.proxy.summarizeWithCopilot('Synthetic conversation');
  const failure = assert.rejects(result, /timed out/);
  for (let i = 0; i < 20 && !f.requests.length; i++) await Promise.resolve();
  assert.equal(f.requests.length, 1);
  t.mock.timers.tick(180000);
  await failure;
  assert.equal(f.clients[0].stops, 1);
  assert.equal(fs.existsSync(f.clients[0].config.baseDirectory), false);
  t.mock.timers.reset();
});

function ipcFixture(t, cli, records, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-summary-ipc-'));
  const file = path.join(home, 'events.jsonl');
  fs.writeFileSync(file, records.map(record => typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
  if (options.missingFile) fs.unlinkSync(file);
  const handlers = new Map(), calls = [];
  const previous = process.env.AGENTPLEX_API_KEY;
  if (options.apiKey) process.env.AGENTPLEX_API_KEY = 'synthetic-key';
  else delete process.env.AGENTPLEX_API_KEY;
  loadSource('src/main/ipc-handlers.ts', {
    electron: { app: { getPath: () => home }, ipcMain: { handle: (id, handler) => handlers.set(id, handler), on() {} } },
    '@anthropic-ai/sdk': { __esModule: true, default: class {
      constructor() { this.messages = { create: async request => {
        calls.push({ provider: 'haiku', request });
        return { content: [{ type: 'text', text: options.answer ?? 'Synthetic Haiku summary' }] };
      } }; }
    } },
    './copilot-summary-proxy': { summarizeWithCopilot: async prompt => {
      calls.push({ provider: 'copilot', prompt });
      if (options.error) throw new Error(options.error);
      return { summary: 'Synthetic Copilot summary', model: 'gpt-4.1' };
    } },
    './session-manager': { sessionManager: {
      list: () => options.missing ? [] : [{ id: 'source', cli }],
      getJsonlPath: () => file, getBuffer: () => options.buffer ?? '\x1b[31mRAW_FALLBACK\x1b[0m',
    } },
    './shell-detector': {}, './settings-manager': {}, './claude-session-scanner': {},
    './copilot-session-scanner': {}, './config-loader': {}, './session-search': {}, './git-operations': {},
  }).registerIpcHandlers();
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTPLEX_API_KEY;
    else process.env.AGENTPLEX_API_KEY = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    calls,
    summarize: () => handlers.get(IPC.SUMMARIZE_CONTEXT)(null, { sessionId: 'source', sourceLabel: 'Synthetic source' }),
  };
}

test('Copilot and picker source sessions summarize full persisted messages and tools without an Anthropic key', async t => {
  for (const cli of ['copilot', 'copilot-resume']) {
    const f = ipcFixture(t, cli, [
      { type: 'user.message', data: { content: 'ORIGINAL_GOAL', transformedContent: 'DO_NOT_INCLUDE_TRANSFORMED' } },
      { type: 'assistant.message', data: { content: 'CURRENT_DECISION' } },
      { type: 'tool.execution_start', data: { toolName: 'powershell', arguments: { command: 'synthetic-command' } } },
      { type: 'tool.execution_complete', data: { success: true, result: { content: 'VERIFIED_RESULT' } } },
      { type: 'assistant.message', agentId: 'child', data: { content: 'CHILD_MESSAGE' } },
      '{partial',
    ]);
    assert.deepEqual(await f.summarize(), { summary: 'Synthetic Copilot summary', error: null });
    assert.equal(f.calls[0].provider, 'copilot');
    assert.match(f.calls[0].prompt, /ORIGINAL_GOAL|CURRENT_DECISION/);
    assert.match(f.calls[0].prompt, /synthetic-command/);
    assert.match(f.calls[0].prompt, /VERIFIED_RESULT/);
    assert.doesNotMatch(f.calls[0].prompt, /RAW_FALLBACK|CHILD_MESSAGE|DO_NOT_INCLUDE_TRANSFORMED/);
  }
});

test('non-Copilot source keeps Haiku, while missing authentication and inference errors return explicit failures', async t => {
  const f = ipcFixture(t, 'claude', [{ type: 'user', message: { content: 'CLAUDE_GOAL' } }], { apiKey: true });
  assert.equal((await f.summarize()).summary, 'Synthetic Haiku summary');
  assert.equal(f.calls[0].provider, 'haiku');
  assert.match(f.calls[0].request.messages[0].content, /CLAUDE_GOAL/);
  const missingKey = ipcFixture(t, 'claude', [], {});
  assert.match((await missingKey.summarize()).error, /AGENTPLEX_API_KEY/);
  const failed = ipcFixture(t, 'copilot', [], { error: 'Synthetic Copilot unavailable' });
  assert.deepEqual(await failed.summarize(), { summary: null, error: 'Synthetic Copilot unavailable' });
  assert.match(failed.calls[0].prompt, /RAW_FALLBACK/);
  const empty = ipcFixture(t, 'copilot', [], { buffer: '' });
  assert.match((await empty.summarize()).error, /No conversation data/);
  assert.equal(empty.calls.length, 0);
  const missing = ipcFixture(t, 'copilot', [], { missing: true });
  assert.match((await missing.summarize()).error, /no longer exists/);
  assert.equal(missing.calls.length, 0);
  const emptyAnswer = ipcFixture(t, 'claude', [], { apiKey: true, answer: '' });
  assert.deepEqual(await emptyAnswer.summarize(), { summary: null, error: 'Haiku returned an empty summary' });
});

test('streamed conversation is bounded to the recent context, with terminal fallback for an unavailable log', async t => {
  const f = ipcFixture(t, 'copilot', [
    { type: 'user.message', data: { content: 'OLD_GOAL' } },
    { type: 'assistant.message', data: { content: 'x'.repeat(120000) } },
    { type: 'user.message', data: { content: 'LATEST_GOAL' } },
  ]);
  await f.summarize();
  const context = f.calls[0].prompt.match(/<conversation>\n([\s\S]*)\n<\/conversation>/)[1];
  assert.equal(context.length, 100000);
  assert.match(context, /LATEST_GOAL/);
  assert.doesNotMatch(context, /OLD_GOAL/);
  const unavailable = ipcFixture(t, 'copilot', [], { missingFile: true });
  assert.equal((await unavailable.summarize()).summary, 'Synthetic Copilot summary');
  assert.match(unavailable.calls[0].prompt, /RAW_FALLBACK/);
});

test('JSONL paths resolve Copilot source and Claude source histories without guessing other session identities', () => {
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    electron: {}, 'node-pty': {}, './copilot-summary-proxy': {},
  });
  const manager = new SessionManager();
  for (const cli of ['copilot', 'copilot-resume']) {
    manager.sessions.set(cli, { cli, cwd: process.cwd(), resumeSessionId: 'exact-uuid' });
    assert.equal(manager.getJsonlPath(cli), path.join(os.homedir(), '.copilot', 'session-state', 'exact-uuid', 'events.jsonl'));
  }
  manager.sessions.set('claude', { cli: 'claude', cwd: process.cwd(), resumeSessionId: 'claude-uuid' });
  assert.ok(manager.getJsonlPath('claude').endsWith('claude-uuid.jsonl'));
  assert.equal(manager.getJsonlPath('unknown'), null);
});

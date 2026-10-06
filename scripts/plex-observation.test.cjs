const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadSource } = require('./test-support.cjs');
const { readPlexTranscript, copilotActivity, mergeActivity, validateActivity } = loadSource('src/main/plex-activity.ts');
const { parseCopilotModels } = loadSource('src/main/plex-models.ts');
const record = (type, data, id = type) => JSON.stringify({ type, data, id }) + '\n';

test('read-only transcript reads only its isolated manifest, handles live partial writes and excludes private reasoning', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-transcript-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(readPlexTranscript(home).started, false);
  const id = '11111111-1111-4111-a111-111111111111';
  fs.writeFileSync(path.join(home, 'plex-conversation.json'), JSON.stringify({ id }));
  assert.equal(readPlexTranscript(home).started, true);
  const folder = path.join(home, 'session-state', id);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'events.jsonl');
  const content = record('user.message', { content: 'Inspect sample' }) +
    record('assistant.message', { content: 'Public answer', reasoningText: 'PRIVATE' }) +
    record('assistant.reasoning', { content: 'PRIVATE' }) +
    record('tool.execution_start', { toolName: 'view', toolCallId: 'call', arguments: { path: 'sample.txt' } }) +
    record('tool.execution_complete', { toolCallId: 'call', success: true, result: { content: 'Two widgets' } }) +
    '{"type":"assistant.message"';
  fs.writeFileSync(file, content);
  const result = readPlexTranscript(home);
  assert.deepEqual(result.entries.map(entry => entry.kind), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  fs.writeFileSync(path.join(home, 'plex-conversation.json'), JSON.stringify({ id: '..\\foreign' }));
  assert.throws(() => readPlexTranscript(home), /Invalid worker conversation/);
});

test('activity is bounded, validates external envelopes, and never projects private reasoning content', () => {
  const entries = [];
  for (let i = 0; i < 200; i++) mergeActivity(entries, { id: String(i), kind: 'assistant', text: 'x'.repeat(8000) });
  assert.ok(entries.reduce((sum, item) => sum + item.text.length, 0) <= 64000);
  assert.throws(() => validateActivity([{ id: 'a', kind: 'raw-private-data', text: 'x' }]), /Invalid/);
  assert.equal(copilotActivity({ type: 'assistant.reasoning', data: { content: 'private' } }), null);
  assert.equal(copilotActivity({ type: 'assistant.reasoning_delta', data: { deltaContent: 'private' } }).text, 'Thinking...');
});

test('model catalogue preserves IDs, labels and account enablement without inventing fallback models', () => {
  assert.deepEqual(parseCopilotModels([
    { modelId: 'auto', name: 'Auto' },
    { modelId: 'provider/model', name: 'Model', _meta: { copilotEnablement: 'disabled' } },
  ]), [{ id: 'auto', name: 'Auto', enabled: true }, { id: 'provider/model', name: 'Model', enabled: false }]);
  assert.throws(() => parseCopilotModels([]), /catalogue/);
  assert.throws(() => parseCopilotModels([{ modelId: '--bad', name: 'Bad' }]), /Invalid/);
});

test('ACP model discovery sends no prompt and releases its own process and temporary home', async () => {
  let home;
  const methods = [];
  let killed = false;
  const { discoverPlexModels } = loadSource('src/main/plex-models.ts', {
    './plex-cli': { githubToken: async () => 'synthetic', copilotCommand: () => 'copilot' },
    'node:child_process': { spawn: (command, args, options) => {
      home = options.cwd;
      assert.ok(args.includes('--acp'));
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stdin = new EventEmitter(); child.stderr = { resume() {} };
      child.stdout.setEncoding = () => {};
      child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', 0)); };
      child.stdin.write = line => {
        const request = JSON.parse(line);
        methods.push(request.method);
        const result = request.id === 1 ? { protocolVersion: 1 } : {
          models: { availableModels: [{ modelId: 'model-one', name: 'One' }] },
        };
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
      };
      return child;
    } },
  });
  assert.deepEqual(await discoverPlexModels(), [{ id: 'model-one', name: 'One', enabled: true }]);
  assert.deepEqual(methods, ['initialize', 'session/new']);
  assert.ok(killed);
  assert.equal(fs.existsSync(home), false);
});

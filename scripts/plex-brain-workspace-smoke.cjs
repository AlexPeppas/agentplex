const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadSource } = require('./test-support.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-brain-workspace-'));
  const cwd = path.join(root, 'workspace');
  const home = path.join(root, 'conversation');
  fs.mkdirSync(cwd);
  const marker = randomUUID();
  fs.writeFileSync(path.join(cwd, 'input.txt'), marker);
  const { runPlexCli } = loadSource('src/main/plex-cli.ts');
  try {
    const request = {
      cwd, conversationHome: home, readOnly: false,
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      signal: AbortSignal.timeout(180000),
    };
    const answer = await runPlexCli({ ...request,
      prompt: 'Synthetic workspace check; do not access anything outside the current working directory. ' +
        'Use glob to locate input.txt, rg to search input.txt with pattern ".+", and view to read input.txt. ' +
        'Use create to create output.txt containing exactly "before", then edit to replace "before" with "after". ' +
        'Use powershell to run (Get-Location).Path | Set-Content -LiteralPath cwd.txt . ' +
        'Do not use PowerShell to substitute for the five named filesystem tools. ' +
        'Return the exact input.txt content in summary. Execute all six tools.',
    });
    assert.ok(answer.summary.includes(marker), 'Brain must report the actual file content');
    assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8').trim(), 'after');
    assert.equal(fs.realpathSync(fs.readFileSync(path.join(cwd, 'cwd.txt'), 'utf8').trim()), fs.realpathSync(cwd));
    const manifest = JSON.parse(fs.readFileSync(path.join(home, 'plex-conversation.json')));
    // Existing brains persist tools:[]; host defaults must not invalidate their identity.
    assert.deepEqual(manifest.tools, []);
    const events = () => fs.readFileSync(path.join(home, 'session-state', manifest.id, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    const rows = events();
    for (const name of ['glob', 'rg', 'view', 'create', 'edit', 'powershell']) {
      const call = rows.find(event => event.type === 'tool.execution_start' &&
        (event.data.toolName === name || (name === 'rg' && event.data.toolName === 'grep')));
      assert.ok(call, `Missing actual ${name} execution; got ${rows.filter(event => event.type === 'tool.execution_start').map(event => event.data.toolName)}`);
      const completion = rows.find(event => event.type === 'tool.execution_complete' && event.data.toolCallId === call.data.toolCallId);
      assert.equal(completion?.data.success, true, `${name}: ${JSON.stringify(completion?.data)}`);
    }
    await runPlexCli({ ...request,
      prompt: 'Use edit to change output.txt from "after" to "resumed". Return a brief summary. Do not access outside the cwd.',
    });
    assert.equal(fs.readFileSync(path.join(cwd, 'output.txt'), 'utf8').trim(), 'resumed');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'plex-conversation.json'))).id, manifest.id);
    console.log('Brain filesystem and shell tools executed in mounted cwd; existing identity and resumed edits retained.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

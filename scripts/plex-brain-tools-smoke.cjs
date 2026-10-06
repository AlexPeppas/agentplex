const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-brain-tools-'));
  const { runPlexCli } = loadSource('src/main/plex-cli.ts');
  try {
    const request = {
      cwd: root, conversationHome: root, readOnly: false,
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
      signal: AbortSignal.timeout(180000),
    };
    const answer = await runPlexCli({ ...request,
      prompt: 'Synthetic capability check. Call web_search to find the purpose of IANA example.com, ' +
        'call web_fetch on https://example.com, and call session_store_sql with SELECT 1 AS synthetic_probe LIMIT 1 ' +
        '(do not read any real conversation data). Return a short summary of actual results. Use all three tools.',
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plex-conversation.json')));
    const events = () => fs.readFileSync(path.join(root, 'session-state', manifest.id, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    const calls = events().filter(event => event.type === 'tool.execution_start');
    for (const name of ['web_search', 'web_fetch', 'session_store_sql']) {
      const call = calls.find(event => event.data.toolName === name ||
        (name === 'web_search' && event.data.toolName === 'github-mcp-server-web_search'));
      assert.ok(call, `Missing actual ${name} execution; got ${calls.map(event => event.data.toolName)}; answer: ${JSON.stringify(answer)}`);
      const completion = events().find(event => event.type === 'tool.execution_complete' && event.data.toolCallId === call.data.toolCallId);
      assert.equal(completion?.data.success, true, `${name}: ${JSON.stringify(completion?.data)}`);
    }
    const count = events().length;
    await runPlexCli({ ...request,
      prompt: '/chronicle Run only SELECT 2 AS synthetic_probe LIMIT 1 to check the history query tool. ' +
        'Do not read real history. Return the result in summary.',
    });
    assert.ok(events().slice(count).some(event =>
      event.type === 'tool.execution_start' && event.data.toolName === 'session_store_sql'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plex-conversation.json'))).id, manifest.id);
    console.log('Brain web search, fetch and /chronicle history query executed; exact-session resume retained.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

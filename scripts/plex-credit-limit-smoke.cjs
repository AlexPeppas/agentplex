const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { loadSource } = require('./test-support.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-credit-resume-'));
  const { githubToken, copilotCommand, runPlexCli } = loadSource('src/main/plex-cli.ts');
  const id = randomUUID();
  const marker = `synthetic-${randomUUID()}`;
  try {
    const token = await githubToken();
    const initial = spawnSync(copilotCommand(), [
      '--session-id', id, '--output-format', 'json', '--available-tools=',
      '--no-custom-instructions', '--disable-builtin-mcps', '--no-ask-user', '--no-remote',
      '--max-ai-credits', '30',
    ], { cwd: root, env: { ...process.env, COPILOT_HOME: root, COPILOT_GITHUB_TOKEN: token },
      input: `Remember this synthetic marker: ${marker}. Return {"summary":"stored"} without tools.`,
      encoding: 'utf8', timeout: 60000 });
    assert.equal(initial.status, 0, initial.stderr);
    fs.writeFileSync(path.join(root, 'plex-conversation.json'), JSON.stringify({ id, cwd: root, readOnly: false, tools: [] }));
    const answer = await runPlexCli({
      cwd: root, conversationHome: root, readOnly: false, schema: {}, signal: new AbortController().signal,
      prompt: 'Return the exact synthetic marker from our previous conversation as {"summary":"<marker>"}. No tools.',
    });
    assert.equal(answer.summary, marker);
    const rows = fs.readFileSync(path.join(root, 'session-state', id, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map(JSON.parse);
    const lastResume = rows.filter(row => row.type === 'session.resume').at(-1);
    assert.equal(lastResume.data.sessionLimits?.maxAiCredits, undefined, JSON.stringify(lastResume.data.sessionLimits));
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'plex-conversation.json'))).id, id);
    console.log(JSON.stringify({ legacyCapCleared: true, sameSessionResumed: true, historyRetained: true, coordinatorReply: true }));
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
})().catch(error => { console.error(error); process.exitCode = 1; });

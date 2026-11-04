const { app, BrowserWindow, Menu, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
const repository = path.resolve(__dirname, '..');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
let win, manager, serial = 0;
const rendererErrors = [];
const wait = async (predicate, label) => {
  const end = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
};
const evaluate = expression => win.webContents.executeJavaScript(expression);
const clickText = text => evaluate(`(() => {
  const button = [...document.querySelectorAll('.terminal-pane button')].find(element => element.textContent.trim() === ${JSON.stringify(text)});
  if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
  button.click();
})()`);
const event = (type, data) => JSON.stringify({ id: `fixture-${++serial}`, type, data, timestamp: new Date().toISOString() }) + '\n';
const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const events = path.join(root, '.copilot', 'session-state', uuid, 'events.jsonl');
fs.mkdirSync(path.dirname(events), { recursive: true });
fs.writeFileSync(path.join(root, 'result.json'), '{"parity":"verified"}');
fs.writeFileSync(events,
  event('user.message', { content: 'Explain the conversation rendering and check the fixtures.' })
  + event('tool.execution_start', { toolCallId: 'tests', toolName: 'powershell', arguments: { description: 'Run targeted regressions' } })
  + event('tool.execution_complete', { toolCallId: 'tests', success: true, result: { content: 'All focused tests passed.' } })
  + event('assistant.message', { content: '**Conversation parity** keeps the original terminal ownership.\n\nParagraphs should start at the left margin. Use `pnpm test` to verify.\n\n- Preserve read-only sessions.\n- Keep tool calls compact.\n\n```ts\nconst ready = true;\n```\n\nOpen result.json for the output.\n\n<script>window.conversationXss=true</script>\n[Unsafe](javascript:alert(1))\n\nBlocked URI: javascript:payload.md\n\n![Untrusted image](https://conversation-test.invalid/image)' }));
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
const deadline = setTimeout(() => { console.error('Conversation E2E deadline'); manager?.stop(); app.exit(1); }, 90000);
deadline.unref();

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'copy' }, { role: 'selectAll' }] }]));
  const overrides = { os: { ...os, homedir: () => root } };
  const { SessionManager } = loadSource('src/main/session-manager.ts', overrides);
  manager = new SessionManager();
  manager.monitorCopilotSession(uuid, root);
  const info = manager.list()[0];
  const snapshot = manager.getConversationSnapshot.bind(manager);
  let delayed = false, failSnapshot = false;
  manager.getConversationSnapshot = id => {
    if (failSnapshot) { failSnapshot = false; throw new Error('Synthetic history unavailable'); }
    const value = snapshot(id);
    if (delayed) return value;
    delayed = true;
    setTimeout(() => fs.appendFileSync(events, event('assistant.message', { content: 'Live response before snapshot.' })), 20);
    return new Promise(resolve => setTimeout(() => resolve(value), 900));
  };
  loadSource('src/main/ipc-handlers.ts', { ...overrides, './session-manager': { sessionManager: manager } }).registerIpcHandlers();
  win = new BrowserWindow({ show: false, width: 1400, height: 1000,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { height: 48, color: '#181c20', symbolColor: '#e4e8ed' } } : {}),
    webPreferences: { preload: path.join(repository, '.vite', 'build', 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3 && !message.includes('Synthetic history unavailable')) rendererErrors.push(message);
  });
  manager.setWindow(win);
  await win.loadFile(path.join(repository, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('[data-id="${info.id}"] > div')`), 'monitored card');
  await evaluate(`document.querySelector('[data-id="${info.id}"] > div').click()`);
  await wait(() => evaluate(`document.querySelector('.copilot-conversation')?.textContent.includes('Live response before snapshot.')`),
    'snapshot race retains live messages');
  assert.equal(await evaluate(`document.querySelectorAll('[data-conversation-kind="assistant"]').length`), 2);
  assert.equal(await evaluate(`document.querySelectorAll('.xterm').length`), 0, 'default conversation must not allocate a hidden xterm');
  assert.equal(await evaluate(`/^\\d{2}:\\d{2}$/.test(document.querySelector('.copilot-message-time').textContent)`), true);
  assert.equal(await evaluate(`!!document.querySelector('.copilot-markdown strong') && !!document.querySelector('.copilot-markdown pre .hljs-keyword')`), true);
  assert.equal(await evaluate(`document.querySelector('.copilot-markdown img')`), null);
  assert.equal(await evaluate(`window.conversationXss`), undefined);
  assert.equal(await evaluate(`document.querySelector('a[href^="javascript:"]')`), null);
  await evaluate(`document.querySelector('button[title="Fullscreen"]').click()`);
  await evaluate(`document.querySelector('button[aria-label="Toggle workspace files"]').click()`);
  win.setContentSize(1080, 850);
  await wait(() => evaluate(`document.querySelector('.copilot-conversation').clientWidth > 900`), 'wide conversation layout');
  const layout = await evaluate(`(() => {
    const paragraphs = [...document.querySelectorAll('.copilot-markdown p')];
    return { first: paragraphs[0].getBoundingClientRect().left, second: paragraphs[1].getBoundingClientRect().left,
      foreground: getComputedStyle(document.querySelector('.copilot-conversation')).color };
  })()`);
  assert.equal(layout.first, layout.second, 'paragraphs share the native Copilot content margin');
  win.webContents.send('app:zoom', 'in');
  await wait(() => evaluate(`getComputedStyle(document.querySelector('.copilot-conversation')).fontSize === '16px'`), 'conversation follows terminal font zoom');
  win.webContents.send('app:zoom', 'reset');
  await wait(() => evaluate(`getComputedStyle(document.querySelector('.copilot-conversation')).fontSize === '14px'`), 'conversation font zoom resets');
  const screenshots = process.env.AGENTPLEX_CONVERSATION_SCREENSHOTS;
  async function capture(name) {
    if (!screenshots) return;
    fs.mkdirSync(screenshots, { recursive: true });
    fs.writeFileSync(path.join(screenshots, name + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await capture('copilot-conversation-wide');
  win.setContentSize(540, 850);
  await wait(() => evaluate(`document.querySelector('.copilot-conversation').clientWidth < 540`), 'narrow conversation layout');
  assert.equal(await evaluate(`(() => {
    const element = document.querySelector('.copilot-conversation-scroll');
    return element.scrollWidth <= element.clientWidth;
  })()`), true, 'narrow conversation wraps rather than overflowing its pane');
  await capture('copilot-conversation-narrow');
  await evaluate(`document.documentElement.dataset.theme = 'light'`);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.copilot-conversation')).color`), layout.foreground);
  await capture('copilot-conversation-stone');
  await evaluate(`document.querySelector('.copilot-tool summary').click()`);
  assert.equal(await evaluate(`document.querySelector('.copilot-tool[open] pre').textContent`), 'All focused tests passed.');
  await evaluate(`document.querySelector('.copilot-markdown a[href="result.json"]').click()`);
  await wait(() => evaluate(`document.querySelector('section[aria-label="File preview"] pre')?.textContent.includes('"parity": "verified"')`),
    'plain artifact path opens native preview');
  await clickText(info.title);
  const previousClipboard = clipboard.availableFormats().map(format => [format, clipboard.readBuffer(format)]);
  try {
    await evaluate(`(() => {
      const element = document.querySelector('.copilot-markdown strong');
      const range = document.createRange(); range.selectNodeContents(element);
      document.querySelector('.copilot-conversation-scroll').focus();
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'C', modifiers: ['control'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'C', modifiers: ['control'] });
    await wait(() => clipboard.readText() === 'Conversation parity', 'native keyboard copies conversation selection');
  } finally {
    clipboard.clear();
    for (const [format, bytes] of previousClipboard) clipboard.writeBuffer(format, bytes);
  }
  for (let i = 0; i < 30; i++) fs.appendFileSync(events, event('assistant.message', { content: `History item ${i}.\n\nA second paragraph keeps this view scrollable.` }));
  await wait(() => evaluate(`document.querySelector('.copilot-conversation').textContent.includes('History item 29.')`), 'live history');
  await evaluate(`(() => {
    const element = document.querySelector('.copilot-conversation-scroll');
    element.scrollTop = 0; element.dispatchEvent(new Event('scroll'));
  })()`);
  fs.appendFileSync(events, event('assistant.message', { content: 'Latest response while reading history.' }));
  await wait(() => evaluate(`document.querySelector('.copilot-conversation').textContent.includes('Latest response while reading history.')`), 'live message while scrolled up');
  assert.equal(await evaluate(`document.querySelector('.copilot-conversation-scroll').scrollTop`), 0);
  await evaluate(`document.querySelector('.copilot-jump-latest').click()`);
  await wait(() => evaluate(`document.querySelector('.copilot-conversation-scroll').scrollTop > 0`), 'jump to latest');
  await clickText('Log');
  await wait(() => evaluate(`!!document.querySelector('.xterm-helper-textarea')`), 'raw terminal log remains available');
  assert.equal(await evaluate(`document.querySelector('.xterm-helper-textarea').readOnly`), true);
  failSnapshot = true;
  await clickText(info.title);
  await wait(() => evaluate(`document.querySelector('[role="alert"]')?.textContent.includes('Synthetic history unavailable')`), 'history failures are visible');
  await clickText('Retry');
  await wait(() => evaluate(`!document.querySelector('[role="alert"]') && document.querySelector('.copilot-conversation').textContent.includes('Latest response while reading history.')`), 'retry recovers history');
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ productionRenderer: true, nativeCopilotMessageLayout: true, renderedMarkdown: true,
    toolDetails: true, raceSafeHydration: true, responsiveParagraphs: true, darkConversationInBothThemes: true,
    plainArtifactLinks: true, nativeClipboard: true, liveScrollPreserved: true, readOnlyRawLog: true, visibleErrorsAndRetry: true }));
  manager.stop();
  win.destroy();
  app.quit();
}).catch(error => { console.error(error); manager?.stop(); if (win && !win.isDestroyed()) win.destroy(); app.exit(1); });

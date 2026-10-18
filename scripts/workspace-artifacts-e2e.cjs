const { app, BrowserWindow, ipcMain, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { createPdf } = require('./pdf-fixture.cjs');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const repository = path.resolve(__dirname, '..');
const rendererRoot = process.env.AGENTPLEX_ARTIFACT_RENDERER_ROOT || repository;
const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.mkdirSync(path.join(workspace, 'nested'));
fs.writeFileSync(path.join(workspace, 'result.json'), '{"verified":"first"}');
fs.writeFileSync(path.join(workspace, 'report.pdf'), createPdf());
fs.writeFileSync(path.join(workspace, 'broken.pdf'), '%PDF-1.7\nbroken document');
fs.writeFileSync(path.join(workspace, 'nested', 'next.json'), '{"nested":true}');
fs.writeFileSync(path.join(workspace, 'summary.md'), '# Native Markdown\n\n| Metric | Value |\n| --- | --- |\n| Tests | Passed |\n\n[Nested JSON](nested/next.json)\n\n<script>window.badMarkdown=true</script>\n<img src="https://preview-test.invalid/image">\n[Unsafe](javascript:alert(1))');
fs.writeFileSync(path.join(workspace, 'report.html'), '<h1 id="report">Native HTML</h1><script>window.badHtml=true</script>'
  + '<img src="https://preview-test.invalid/image"><a href="https://preview-test.invalid/navigation">Navigate</a>'
  + '<a href="https://preview-test.invalid/popup" target="_blank">Popup</a><form action="https://preview-test.invalid/form"><button>Send</button></form>');
const stateRoot = path.join(root, '.copilot', 'session-state');
fs.mkdirSync(stateRoot, { recursive: true });
const uuid = '12345678-1234-4234-8234-123456789012';
const events = path.join(stateRoot, uuid, 'events.jsonl');
const record = (type, data) => JSON.stringify({ type, timestamp: new Date().toISOString(), data }) + '\n';
let manager, win;
const network = [], rendererErrors = [];
const wait = async (predicate, label) => {
  const end = Date.now() + 20000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
};
const evaluate = expression => win.webContents.executeJavaScript(expression);
const clickText = async (text, scope = 'document') => {
  await evaluate(`(() => {
    const button = [...${scope}.querySelectorAll('button')].find(button => button.textContent.trim() === ${JSON.stringify(text)});
    if (!button) throw new Error('Missing button: ' + ${JSON.stringify(text)});
    button.click();
  })()`);
};
const preview = `[...document.querySelectorAll('section[aria-label="File preview"]')].find(element => element.getBoundingClientRect().width > 0)`;
async function clickTerminalText(text, attempt = 0) {
  await evaluate(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
  const point = await evaluate(`(() => {
    const walker = document.createTreeWalker(document.querySelector('.xterm-rows'), NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const index = node.textContent.replace(/\\u00a0/g, ' ').indexOf(${JSON.stringify(text)});
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index + 1); range.setEnd(node, index + 2);
      const rect = range.getBoundingClientRect();
      const row = node.parentElement.closest('.xterm-rows > div').getBoundingClientRect();
      if (rect.width && row.height) return {x: Math.floor(rect.x + rect.width / 2), y: Math.floor(row.y + row.height / 2)};
    }
    throw new Error('Terminal link not visible: ' + ${JSON.stringify(text)});
  })()`);
  const dispatch = type => evaluate(`(() => {
    const target = document.elementFromPoint(${point.x}, ${point.y});
    if (!target?.closest('.xterm')) throw new Error('Terminal link hit test failed: ' + target?.outerHTML);
    target.dispatchEvent(new MouseEvent(${JSON.stringify(type)}, { bubbles: true, clientX: ${point.x}, clientY: ${point.y}, button: 0 }));
  })()`);
  await evaluate(`document.querySelector('.xterm-screen').dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${point.x + 80}, clientY: ${point.y + 20} }))`);
  await dispatch('mousemove');
  await new Promise(resolve => setTimeout(resolve, 250));
  const hover = await evaluate(`(() => {
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { pointer: !!document.querySelector('.xterm-cursor-pointer'), point: ${JSON.stringify(point)},
      screen: { x: screen.x, y: screen.y, width: screen.width, height: screen.height },
      target: document.elementFromPoint(${point.x}, ${point.y})?.className,
      rows: [...document.querySelectorAll('.xterm-rows > div')].map((element, index) => ({
        index, text: element.textContent, top: element.getBoundingClientRect().y, height: element.getBoundingClientRect().height
      })).filter(row => row.text).slice(0, 20) };
  })()`);
  if (!hover.pointer && attempt < 3) return clickTerminalText(text, attempt + 1);
  assert.equal(hover.pointer, true, JSON.stringify(hover));
  await dispatch('mousedown');
  await dispatch('mouseup');
}

app.whenReady().then(async () => {
  const overrides = {
    os: { ...os, homedir: () => root },
    'node-pty': { spawn() { assert.fail('A discovered CLI must not spawn another process'); } },
  };
  const { SessionManager } = loadSource('src/main/session-manager.ts', overrides);
  manager = new SessionManager();
  loadSource('src/main/ipc-handlers.ts', {
    ...overrides, './session-manager': { sessionManager: manager },
  }).registerIpcHandlers();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.url.startsWith('https://preview-test.invalid')) network.push(details.url);
    callback({});
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:",
    ] },
  }));
  manager.start();
  await wait(() => !manager.discovery.baseline, 'historical baseline');
  win = new BrowserWindow({ show: false, width: 1400, height: 1000,
    webPreferences: { preload: path.join(repository, '.vite', 'build', 'preload.js'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  loadSource('src/main/preview-navigation.ts').installPreviewNavigation(win.webContents);
  win.webContents.on('console-message', event => {
    if (/Uncaught|Minified React error|Setting up fake worker|Failed to load font|Unable to load (?:font|CMap)/.test(event.message)) rendererErrors.push(event.message);
  });
  manager.setWindow(win);
  await win.loadFile(path.join(rendererRoot, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('.react-flow')`), 'full production renderer');
  fs.mkdirSync(path.dirname(events));
  fs.writeFileSync(events, record('session.start', { context: { cwd: workspace } })
    + record('assistant.message', { content: 'Open `result.json` for the generated output.\nRead `report.pdf` for the PDF.' }));
  await wait(() => manager.list().length === 1, 'new CLI discovery');
  const info = manager.list()[0];
  assert.equal(info.readOnly, true);
  await wait(() => evaluate(`!!document.querySelector('[data-id="${info.id}"]')`), 'normal graph node');
  await evaluate(`document.querySelector('[data-id="${info.id}"] > div').click()`);
  await wait(() => evaluate(`!!document.querySelector('.xterm-rows') && document.querySelector('aside[aria-label="Workspace files"]')?.textContent.includes('result.json')`), 'terminal and workspace tree');
  await evaluate(`window.testTerminalElement = document.querySelector('.xterm')`);
  assert.equal(await evaluate(`document.querySelector('.xterm-helper-textarea').readOnly`), true);
  win.setContentSize(900, 1000);
  await wait(() => evaluate(`getComputedStyle(document.querySelector('aside[aria-label="Workspace files"]')).display === 'none'`), 'narrow panes preserve terminal space');
  win.setContentSize(1400, 1000);
  await wait(() => evaluate(`document.querySelector('aside[aria-label="Workspace files"]').getBoundingClientRect().width > 0`), 'workspace returns in a wide pane');
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('result.json')`), 'transcript file link');
  await clickTerminalText('result.json');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"verified": "first"')`), 'plain terminal path opens native JSON tab');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true);
  await clickText(info.title);
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.includes('report.pdf')`), 'PDF terminal link');
  await clickTerminalText('report.pdf');
  const pdfCanvas = `(${preview})?.querySelector('canvas[data-rendered="true"]')`;
  await wait(() => evaluate(`!!(${pdfCanvas})`), 'PDF renders from terminal link');
  assert.equal(await evaluate(`(${preview}).textContent.includes('Page 1 of 2')`), true);
  assert.deepEqual(await evaluate(`Array.from((${pdfCanvas}).getContext('2d').getImageData(5, 5, 1, 1).data)`), [255, 0, 0, 255]);
  assert.ok(await evaluate(`(() => {
    const canvas = (${pdfCanvas});
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let textPixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] + pixels[index + 1] + pixels[index + 2] < 60 && pixels[index + 3] > 200) textPixels++;
    }
    return textPixels > 40;
  })()`), 'PDF text glyphs must render, not only the page background');
  await clickText('Next page', `(${preview})`);
  await wait(() => evaluate(`!!(${pdfCanvas}) && (${preview}).textContent.includes('Page 2 of 2')`), 'PDF page navigation');
  assert.deepEqual(await evaluate(`Array.from((${pdfCanvas}).getContext('2d').getImageData(5, 5, 1, 1).data)`), [0, 0, 255, 255]);
  await evaluate(`(() => { const zoom = (${preview}).querySelector('select[aria-label="PDF zoom"]'); zoom.value = '1.5'; zoom.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(() => evaluate(`!!(${pdfCanvas}) && (${pdfCanvas}).style.width === '360px'`), 'PDF zoom');
  await clickText('Previous page', `(${preview})`);
  await wait(() => evaluate(`!!(${pdfCanvas}) && (${preview}).textContent.includes('Page 1 of 2')`), 'PDF previous page');
  await clickText('Reload', `(${preview})`);
  await wait(() => evaluate(`!!(${pdfCanvas})`), 'PDF reload');
  await evaluate(`(() => {
    const buttons = [...(${preview}).querySelectorAll('button')];
    const next = buttons.find(button => button.textContent === 'Next page');
    const previous = buttons.find(button => button.textContent === 'Previous page');
    next.click();
    requestAnimationFrame(() => previous.click());
  })()`);
  await wait(() => evaluate(`!!(${pdfCanvas}) && (${preview}).textContent.includes('Page 1 of 2')`), 'PDF cancels obsolete page renders');
  assert.equal(await evaluate(`typeof window.badPdf`), 'undefined', 'PDF JavaScript must not execute');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true);
  await clickText('broken.pdf', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`(${preview})?.querySelector('[role="alert"]')?.textContent.includes('Cannot open PDF')`), 'corrupt PDFs show an explicit reader error');
  await clickText('report.pdf', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`!!(${pdfCanvas})`), 'PDF tree reopens existing tab');
  await evaluate(`document.querySelector('button[aria-label="Close report.pdf"]').click()`);
  await wait(() => evaluate(`!document.querySelector('button[aria-label="Close report.pdf"]')`), 'PDF tab closes');
  await clickText('report.pdf', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`!!(${pdfCanvas})`), 'PDF reader reopens after disposing its worker');
  await clickText('summary.md', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`(${preview})?.querySelector('article h1')?.textContent === 'Native Markdown'`), 'native Markdown');
  assert.equal(await evaluate(`!!(${preview}).querySelector('table')`), true);
  assert.equal(await evaluate(`(${preview}).querySelector('script, img') === null`), true);
  await evaluate(`(${preview}).querySelector('a').click()`);
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"nested": true')`), 'relative Markdown link opens sibling file');
  await clickText('report.html', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`!!(${preview})?.querySelector('iframe')`), 'HTML preview');
  await wait(() => win.webContents.mainFrame.framesInSubtree.some(frame => frame.url === 'about:srcdoc'), 'sandboxed document');
  const frame = win.webContents.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc');
  // In-process CDP inspects script-disabled frames without opening a TCP listener.
  const contexts = new Map();
  const targets = [];
  win.webContents.debugger.on('message', (_event, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') targets.push(params);
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) {
      contexts.set(sessionId || params.context.auxData.frameId, params.context.id);
    }
  });
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Runtime.enable');
  await win.webContents.debugger.sendCommand('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const tree = await win.webContents.debugger.sendCommand('Page.getFrameTree');
  const htmlFrame = tree.frameTree.childFrames?.find(child => child.frame.url === 'about:srcdoc')?.frame.id;
  let targetSession;
  if (!htmlFrame) {
    await wait(() => targets.some(target => target.targetInfo.type === 'iframe'), 'sandboxed frame target');
    targetSession = targets.find(target => target.targetInfo.type === 'iframe').sessionId;
    await win.webContents.debugger.sendCommand('Runtime.enable', {}, targetSession);
  }
  await wait(() => contexts.has(targetSession || htmlFrame), 'sandbox inspection context');
  const inspectHtml = async expression => {
    const result = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
      expression, contextId: contexts.get(targetSession || htmlFrame), returnByValue: true, allowUnsafeEvalBlockedByCSP: true,
    }, targetSession);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  await wait(() => inspectHtml(`document.querySelector('h1')?.textContent === 'Native HTML'`), 'HTML native layout');
  const isolation = await inspectHtml(`({ node: typeof require, ipc: typeof window.agentPlex, scriptRan: !!window.badHtml })`);
  assert.deepEqual(isolation, { node: 'undefined', ipc: 'undefined', scriptRan: false });
  await inspectHtml(`document.querySelector('a').click(); document.querySelectorAll('a')[1].click(); document.querySelector('form').requestSubmit()`);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(frame.url, 'about:srcdoc');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  assert.deepEqual(network, []);
  win.webContents.debugger.detach();
  await clickText(info.title);
  fs.appendFileSync(events, record('assistant.message', { content: '\x1b]8;;' + require('node:url').pathToFileURL(path.join(workspace, 'result.json')).href + '\x07Open OSC artifact\x1b]8;;\x07' }));
  await wait(() => evaluate(`document.querySelector('.xterm-rows').textContent.replace(/\\u00a0/g, ' ').includes('Open OSC artifact')`), 'live transcript reaches same terminal');
  await clickTerminalText('Open OSC artifact');
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('"verified": "first"')`), 'OSC8 file link opens native preview');
  fs.writeFileSync(path.join(workspace, 'result.json'), '{"verified":"reloaded"}');
  await clickText('Reload', `(${preview})`);
  await wait(() => evaluate(`(${preview})?.querySelector('pre')?.textContent.includes('reloaded')`), 'file reload');
  assert.equal(await evaluate(`window.testTerminalElement.isConnected`), true);
  const mounted = path.join(root, 'mounted');
  fs.mkdirSync(mounted);
  fs.writeFileSync(path.join(mounted, 'mounted.md'), '# Mounted workspace');
  fs.appendFileSync(events, record('session.resume', { context: { cwd: mounted } }));
  await wait(() => evaluate(`document.querySelector('aside[aria-label="Workspace files"]')?.textContent.includes('mounted.md')`), 'provider workspace changes refresh directory');
  await clickText('mounted.md', `document.querySelector('aside[aria-label="Workspace files"]')`);
  await wait(() => evaluate(`(${preview})?.querySelector('h1')?.textContent === 'Mounted workspace'`), 'mounted file preview');
  manager.kill(info.id);
  fs.appendFileSync(events, record('assistant.message', { content: 'External CLI continues independently.' }));
  await new Promise(resolve => setTimeout(resolve, 1800));
  assert.equal(manager.list().length, 0, 'stopped monitors must not immediately reattach');
  assert.deepEqual(rendererErrors, []);
  console.log(JSON.stringify({ normalCliDiscovery: true, plainAndOsc8Links: true, jsonMarkdownHtml: true, pdfPagesZoomReload: true,
    htmlSandbox: isolation, blockedNetwork: true, workspaceMounts: true, terminalPreserved: true, externalProcessOwnership: true }));
  manager.stop();
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (win && !win.isDestroyed()) {
    win.webContents.executeJavaScript('document.body.innerText.slice(-5000)').then(text => {
      console.error('Renderer state:', text);
      manager?.stop();
      win.destroy();
      app.exit(1);
    }).catch(() => app.exit(1));
    return;
  }
  manager?.stop();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});

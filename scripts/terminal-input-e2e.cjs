const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const repository = path.resolve(__dirname, '..');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');
let manager, win, native, injectOutput;
let nativeChunks = 0, deliveredChunks = 0;
const errors = [];
const wait = async (predicate, label) => {
  const end = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
const evaluate = expression => win.webContents.executeJavaScript(expression);
process.on('uncaughtException', error => {
  console.error(error);
  manager?.stop();
  app.exit(1);
});
const timeout = setTimeout(() => {
  console.error('Native input E2E exceeded its deadline');
  manager?.stop();
  app.exit(1);
}, 60000);
timeout.unref();
const child = `
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let input = '', sequence = 0, quietUntil = 0;
  process.stdin.on('data', data => {
    for (const char of data.toString()) {
      if (char === '\\x10') {
        quietUntil = Date.now() + 10000;
        process.stdout.write('\\r\\nSTREAM_PAUSED\\r\\n');
        continue;
      }
      if (char === '\\r') {
        process.stdout.write('\\r\\nECHO:' + input + '\\r\\n');
        input = '';
        quietUntil = Date.now() + 150;
      } else if (char >= ' ') input += char;
    }
  });
  process.stdout.write('INPUT_READY\\r\\n');
  setInterval(() => {
    if (Date.now() < quietUntil) return;
    process.stdout.write('BACKGROUND_' + sequence++ + ' ' + 'streaming '.repeat(8) + '\\r\\n');
  }, 4);
`;

app.whenReady().then(async () => {
  const executable = require('node:child_process').execFileSync('node', ['-p', 'process.execPath'],
    { encoding: 'utf8', windowsHide: true }).trim();
  const overrides = {
    os: { ...os, homedir: () => root },
    './shell-detector': {
      getShellById: () => ({ id: 'input-fixture', path: executable }),
      getCachedShells: () => [],
      detectShells: async () => [],
    },
    'node-pty': {
      spawn(_shell, _args, options) {
        native = require('node-pty').spawn(executable, ['-e', child], options);
        return {
          pid: native.pid,
          onData(callback) {
            injectOutput = callback;
            return native.onData(data => { nativeChunks++; callback(data); });
          },
          onExit: callback => native.onExit(callback),
          write: data => native.write(data),
          resize: (cols, rows) => native.resize(cols, rows),
          kill: () => native.kill(),
        };
      },
    },
  };
  const { SessionManager } = loadSource('src/main/session-manager.ts', overrides);
  manager = new SessionManager();
  loadSource('src/main/ipc-handlers.ts', { ...overrides, './session-manager': { sessionManager: manager } }).registerIpcHandlers();
  win = new BrowserWindow({ show: false, width: 1400, height: 900,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { height: 48, color: '#181c20', symbolColor: '#e4e8ed' } } : {}),
    webPreferences: { preload: path.join(repository, '.vite', 'build', 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', event => {
    if (/Uncaught|Minified React error/.test(event.message)) errors.push(event.message);
  });
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => {
    if (channel === IPC.SESSION_DATA) deliveredChunks++;
    return send(channel, ...args);
  };
  manager.setWindow(win);
  await win.loadFile(path.join(repository, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('.react-flow')`), 'production renderer');
  const info = manager.create(root, 'input-fixture');
  manager.send(IPC.SESSION_CREATED, info);
  await wait(() => evaluate(`!!document.querySelector('[data-id="${info.id}"]')`), 'managed PTY card');
  await evaluate(`document.querySelector('[data-id="${info.id}"] > div').click()`);
  await wait(() => evaluate(`!!document.querySelector('.xterm-helper-textarea')`), 'managed PTY pane');
  await wait(() => manager.getBuffer(info.id).includes('INPUT_READY'), 'test-owned child ready');
  await new Promise(resolve => setTimeout(resolve, 300));
  const latencies = [];
  for (let index = 0; index < 8; index++) {
    const message = `input-probe-${index}`;
    await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
    const began = performance.now();
    await win.webContents.insertText(message);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(`ECHO:${message}`)})`),
      'typed message traverses native input, IPC, real PTY and visible output');
    latencies.push(Math.round(performance.now() - began));
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  assert.ok(Math.max(...latencies) < 1000, `native input stalled: ${latencies}`);
  const marker = 'BACKLOG_COMPLETE';
  manager.write(info.id, '\x10');
  await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('STREAM_PAUSED')`), 'test stream paused for backlog inspection');
  injectOutput('x'.repeat(512 * 1024) + '\r\nBUFFER_WARMED\r\n');
  await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('BUFFER_WARMED')`), 'large output is fully parsed');
  const before = deliveredChunks;
  // Exercise the same PTY callback in a fragmented burst with a full replay buffer.
  for (let index = 0; index < 2000; index++) injectOutput('fragment ');
  injectOutput(`\r\n${marker}\r\n`);
  await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('${marker}')`), 'fragmented output drains visibly');
  assert.ok(deliveredChunks - before < 20, 'fragmented output must not publish thousands of renderer updates');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ nativeInputEchoMs: latencies, maximumInputEchoMs: Math.max(...latencies),
    nativeChunks, deliveredChunks, fragmentedBurstMessages: deliveredChunks - before,
    productionRenderer: true, realPty: true, nativeKeyboardAndPreload: true }));
  manager.stop();
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  manager?.stop();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});

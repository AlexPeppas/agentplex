const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
const repository = path.resolve(__dirname, '..');
app.setPath('appData', root);
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
// Recreate the window and manager without quitting the isolated Electron host.
app.on('window-all-closed', () => {});
Object.assign(process.env, {
  COPILOT_HOME: path.join(root, '.copilot'), COPILOT_AUTO_UPDATE: 'false', COPILOT_OFFLINE: 'true',
  COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:9/v1',
  COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'synthetic-offline-token',
  COPILOT_MODEL: 'offline-test-model',
});
fs.mkdirSync(process.env.COPILOT_HOME);
fs.writeFileSync(path.join(process.env.COPILOT_HOME, 'config.json'), JSON.stringify({
  trusted_folders: [root], disableAllHooks: true, 'ide.autoConnect': false,
}));
let manager, win;
const owned = [];
const wait = async (predicate, label) => {
  const end = Date.now() + 30000;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
const evaluate = expression => win.webContents.executeJavaScript(expression);
process.on('uncaughtException', error => {
  console.error(error);
  app.exit(1);
});
const deadline = setTimeout(() => {
  console.error('Real Copilot startup E2E exceeded its deadline');
  manager?.stop();
  app.exit(1);
}, 90000);
deadline.unref();
function newManager() {
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    os: { ...os, homedir: () => root },
    'node-pty': { spawn(...args) {
      const term = require('node-pty').spawn(...args);
      const item = { term, exited: false };
      owned.push(item);
      term.onExit(() => { item.exited = true; });
      const kill = term.kill.bind(term);
      term.kill = () => { if (!item.exited) kill(); };
      return term;
    } },
  });
  return new SessionManager();
}
async function openWindow() {
  win = new BrowserWindow({
    show: false, width: 1400, height: 900,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden',
      titleBarOverlay: { height: 48, color: '#181c20', symbolColor: '#e4e8ed' } } : {}),
    webPreferences: {
      preload: path.join(repository, '.vite', 'build', 'preload.js'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false,
    },
  });
  manager.setWindow(win);
  await win.loadFile(path.join(repository, '.vite', 'renderer', 'main_window', 'index.html'));
  await wait(() => evaluate(`!!document.querySelector('.react-flow')`), 'production renderer');
}
async function typeIntoCli(info, marker) {
  await wait(() => evaluate(`!!document.querySelector('[data-id="${info.id}"] > div')`), 'managed Copilot card');
  await evaluate(`document.querySelector('[data-id="${info.id}"] > div').click()`);
  await wait(() => evaluate(`!!document.querySelector('.xterm-helper-textarea')`), 'actual xterm pane');
  await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('Interactive')`), 'Copilot input readiness');
  assert.ok(!manager.getBuffer(info.id).includes('Detected terminal Windows'),
    'an AgentPlex PTY must not inherit the parent Windows Terminal setup flow');
  await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`);
  await win.webContents.insertText(marker);
  await wait(() => evaluate(`document.querySelector('.xterm-rows')?.textContent.includes(${JSON.stringify(marker)})`),
    'native keyboard, preload, real Copilot and visible echo');
}
async function closeCli() {
  for (let attempt = 0; attempt < 4 && owned.some(item => !item.exited); attempt++) {
    for (const item of owned) if (!item.exited) item.term.write('\x03');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await wait(() => owned.every(item => item.exited), 'owned CLI exits');
  manager.stop();
}
app.whenReady().then(async () => {
  manager = newManager();
  const bridge = new Proxy({}, { get: (_target, key) => {
    const value = manager[key];
    return typeof value === 'function' ? value.bind(manager) : value;
  } });
  loadSource('src/main/ipc-handlers.ts', { './session-manager': { sessionManager: bridge },
    os: { ...os, homedir: () => root } }).registerIpcHandlers();
  await openWindow();
  const started = Date.now();
  const info = manager.create(root, 'copilot');
  manager.send('session:created', info);
  await typeIntoCli(info, 'offline-input-probe');
  const firstReadyMs = Date.now() - started;
  const directory = path.join(root, '.copilot', 'session-state', info.resumeSessionId);
  assert.ok(fs.statSync(directory).isDirectory(), 'CLI and AgentPlex use the same UUID');
  manager.updateDisplayName(info.id, 'Offline identity test');
  await closeCli();
  win.destroy();
  manager = newManager();
  const restartedAt = Date.now();
  await openWindow();
  await wait(() => manager.list().length === 1, 'saved CLI restoration');
  const restored = manager.list()[0];
  assert.equal(restored.resumeSessionId, info.resumeSessionId);
  assert.equal(restored.displayName, 'Offline identity test');
  await typeIntoCli(restored, 'restarted-input-probe');
  const ids = fs.readdirSync(path.join(root, '.copilot', 'session-state')).filter(name => /^[0-9a-f-]{36}$/i.test(name));
  assert.deepEqual(ids, [info.resumeSessionId], 'restart cannot mint a different conversation');
  console.log(JSON.stringify({ realCopilot: true, firstReadyMs, restartReadyMs: Date.now() - restartedAt,
    exactUuidAcrossRestart: true, productionRenderer: true, nativeKeyboardAndPreload: true, inferenceCalls: 0 }));
  await closeCli();
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (manager) for (const info of manager.list()) {
    console.error('Isolated CLI output:', manager.getBuffer(info.id).slice(-2000));
  }
  manager?.stop();
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(1);
});

// Run via node scripts/run-git-editor-e2e.cjs. Real React/Monaco, IPC and writes;
// only provider sessions are synthetic, and all edits target an owned directory.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadSource } = require('./test-support.cjs');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run this test through scripts/run-git-editor-e2e.cjs');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();
const gitRoot = path.join(root, 'repository');
fs.mkdirSync(gitRoot);
const git = (...args) => execFileSync('git', ['-c', 'user.name=AgentPlex test', '-c', 'user.email=test@example.invalid',
  '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`, ...args], { cwd: gitRoot, stdio: 'pipe' });
git('init');
for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(gitRoot, name), `${name}:base\n`);
git('add', '.'); git('commit', '-m', 'baseline');
for (const name of ['a.txt', 'b.txt']) fs.writeFileSync(path.join(gitRoot, name), `${name}:initial\n`);
const { IPC } = loadSource('src/shared/ipc-channels.ts');
let releaseDiff;
loadSource('src/main/ipc-handlers.ts', {
  electron: { app, ipcMain: {
    handle(channel, handler) {
      ipcMain.handle(channel, async (...args) => {
        if (channel === IPC.GIT_FILE_DIFF && args[1].filePath === 'b.txt' && releaseDiff === null) {
          await new Promise(resolve => { releaseDiff = resolve; });
        }
        return handler(...args);
      });
    },
    on() {},
  } },
  './session-manager': { sessionManager: { getSessionCwd: () => gitRoot } },
  './shell-detector': {}, './settings-manager': {}, './claude-session-scanner': {},
  './copilot-session-scanner': {}, './config-loader': {}, './session-search': {},
}).registerIpcHandlers();
ipcMain.handle('e2e:hold-diff', () => { releaseDiff = null; });
ipcMain.handle('e2e:release-diff', () => {
  assert.equal(typeof releaseDiff, 'function');
  const release = releaseDiff;
  releaseDiff = undefined;
  release();
});
ipcMain.handle('e2e:files', () => Object.fromEntries(['a.txt', 'b.txt'].map(name => [name, fs.readFileSync(path.join(gitRoot, name), 'utf8')])));

async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { ipcRenderer } = require('electron');
  const fromRoot = name => require(require.resolve(name, { paths: [repositoryRoot] }));
  const React = fromRoot('react');
  const { createRoot } = fromRoot('react-dom/client');
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const { IPC } = loadSource('src/shared/ipc-channels.ts');
  const monacoReact = fromRoot('@monaco-editor/react');
  const installedVs = path.join(path.dirname(require.resolve('monaco-editor/package.json', { paths: [repositoryRoot] })), 'min', 'vs');
  // Asset packaging is the separate, deferred #67 work item.
  monacoReact.loader.config({ paths: { vs: pathToFileURL(installedVs).href } });
  window.agentPlex = {
    gitStatus: sessionId => ipcRenderer.invoke(IPC.GIT_STATUS, { sessionId }),
    gitBranchInfo: sessionId => ipcRenderer.invoke(IPC.GIT_BRANCH_INFO, { sessionId }),
    gitFileDiff: (sessionId, filePath, staged) => ipcRenderer.invoke(IPC.GIT_FILE_DIFF, { sessionId, filePath, staged }),
    gitSaveFile: (sessionId, filePath, content) => ipcRenderer.invoke(IPC.GIT_SAVE_FILE, { sessionId, filePath, content }),
    onZoom: () => () => {},
  };
  const editors = [];
  function CapturedDiffEditor(props) {
    return React.createElement(monacoReact.DiffEditor, { ...props, onMount(editor, monaco) {
      const modified = editor.getModifiedEditor();
      const addCommand = modified.addCommand.bind(modified);
      const entry = { editor, modified, models: editor.getModel() };
      modified.addCommand = (...args) => entry.command = addCommand(...args);
      editors.push(entry);
      props.onMount(editor, monaco);
    } });
  }
  const { GitDiffPanel } = loadSource('src/renderer/components/GitDiffPanel.tsx', {
    '@monaco-editor/react': { DiffEditor: CapturedDiffEditor, loader: { config() {} } },
  });
  const style = document.createElement('style');
  style.textContent = '*{box-sizing:border-box}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.h-full{height:100%}.min-h-0{min-height:0}.min-w-0{min-width:0}.shrink-0{flex-shrink:0}.w-56{width:224px}';
  document.head.append(style);
  const host = document.createElement('div');
  host.style.cssText = 'width:1000px;height:650px';
  document.body.append(host);
  const reactRoot = createRoot(host);
  reactRoot.render(React.createElement(GitDiffPanel, { sessionId: 'synthetic-session' }));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 15_000;
    while (!(await predicate())) {
      if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const select = name => {
    const row = [...host.querySelectorAll('div.group')].find(element => element.textContent.includes(name));
    assert.ok(row, `file row ${name}`);
    row.click();
  };
  const files = () => ipcRenderer.invoke('e2e:files');
  await wait(() => host.querySelectorAll('div.group').length === 2, 'changed-file rows');
  select('a.txt');
  await wait(() => editors.length === 1, 'first Monaco editor');
  editors[0].modified.setValue('A_EDITED\n');
  await wait(() => !host.querySelector('button[title="Save (Ctrl+S)"]').disabled, 'first edit state');
  editors[0].modified.trigger('e2e', editors[0].command, null);
  await wait(async () => (await files())['a.txt'] === 'A_EDITED\n', 'first save completion');
  assert.equal((await files())['a.txt'], 'A_EDITED\n');

  await ipcRenderer.invoke('e2e:hold-diff');
  select('b.txt');
  await wait(() => host.querySelector('button[title="Save (Ctrl+S)"]').disabled, 'pending diff blocks saving');
  assert.equal((await files())['b.txt'], 'b.txt:initial\n');
  await ipcRenderer.invoke('e2e:release-diff');
  await wait(() => editors.length === 2, 'second keyed Monaco editor');
  assert.equal(editors[0].models.original.isDisposed(), true);
  assert.equal(editors[0].models.modified.isDisposed(), true);
  editors[1].modified.setValue('B_EDITED\n');
  await wait(() => !host.querySelector('button[title="Save (Ctrl+S)"]').disabled, 'second edit state');
  editors[1].modified.trigger('e2e', editors[1].command, null);
  await wait(async () => (await files())['b.txt'] === 'B_EDITED\n', 'second shortcut save');
  assert.deepEqual(await files(), { 'a.txt': 'A_EDITED\n', 'b.txt': 'B_EDITED\n' });
  editors[1].modified.setValue('B_BUTTON\n');
  await wait(() => !host.querySelector('button[title="Save (Ctrl+S)"]').disabled, 'button edit state');
  host.querySelector('button[title="Save (Ctrl+S)"]').click();
  await wait(async () => (await files())['b.txt'] === 'B_BUTTON\n', 'button save');
  assert.deepEqual(await files(), { 'a.txt': 'A_EDITED\n', 'b.txt': 'B_BUTTON\n' });
  reactRoot.unmount();
  await wait(() => editors[1].models.original.isDisposed() && editors[1].models.modified.isDisposed(), 'final model disposal');
  return { realMonaco: true, realIpcAndGit: true, shortcutAndButtonSaves: true, pendingDiffBlocked: true };
}

let window;
const rendererErrors = [];
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') {
      rendererErrors.push(event.message);
      console.error('[editor-e2e renderer]', event.message);
    }
  });
  const page = path.join(root, 'editor.html');
  fs.writeFileSync(page, '<!doctype html><html><body></body></html>');
  await window.loadFile(page);
  const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))})`);
  assert.deepEqual(rendererErrors, [], 'the editor E2E must not hide renderer errors');
  console.log(JSON.stringify(result));
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});

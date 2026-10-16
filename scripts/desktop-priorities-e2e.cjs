const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadSource } = require('./test-support.cjs');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('appData', root);
app.disableHardwareAcceleration();
let focusRequests = 0;
const { claimApplicationInstance } = loadSource('src/main/application-instance.ts');
const owner = claimApplicationInstance(app, () => { focusRequests++; });
const secondary = process.argv.includes('--ownership-secondary');
if (secondary && owner) {
  console.error('A second Electron process acquired the existing state namespace');
  app.exit(1);
}

async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [repositoryRoot] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [repositoryRoot] }));
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const { useAppStore } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const projectRequests = [], sessionRequests = [], searches = [], cancellations = [], creates = [], saves = [];
  let createGate;
  const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  };
  const enqueue = (list, args) => {
    const request = { ...deferred(), args };
    list.push(request);
    return request.promise;
  };
  window.agentPlex = {
    scanProjects: cli => enqueue(projectRequests, { cli }),
    scanSessions: (project, cli) => enqueue(sessionRequests, { project, cli }),
    searchSessions: query => enqueue(searches, { query }),
    cancelHistoryRequests: kind => cancellations.push(kind),
    createSession: async (cwd, cli, uuid) => {
      creates.push({ cwd, cli, uuid });
      if (createGate) await createGate.promise;
      return { id: `created-${creates.length}`, cwd, cli, resumeSessionId: uuid, status: 'idle', title: 'Same name' };
    },
    updateSessionState() {},
    templatesLoad: async () => [],
    templatesSave: async templates => { saves.push(templates); },
  };
  const { ProjectLauncher } = loadSource('src/renderer/components/ProjectLauncher.tsx', {
    '../store': { useAppStore },
  });
  const { SearchPanel } = loadSource('src/renderer/components/panels/SearchPanel.tsx', {
    '../../store': { useAppStore },
  });
  const { TemplatesPanel } = loadSource('src/renderer/components/panels/TemplatesPanel.tsx', {
    '../../store': { useAppStore },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 50));
  const clickText = text => {
    const node = [...host.querySelectorAll('div,button')].find(node => node.textContent === text);
    assert.ok(node, `missing clickable text: ${text}`);
    (node.tagName === 'BUTTON' ? node : node.closest('.cursor-pointer')).click();
  };
  const input = value => {
    const element = host.querySelector('input');
    assert.ok(element);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  };
  function LauncherHarness() {
    const open = useAppStore(s => s.launcherOpen);
    const identity = useAppStore(s => `${s.launcherMode}:${s.launcherCli}`);
    return open ? React.createElement(ProjectLauncher, { key: identity }) : null;
  }
  useAppStore.getState().openLauncher('resume', 'copilot');
  reactRoot.render(React.createElement(LauncherHarness));
  await wait(() => projectRequests.length === 1, 'first provider scan');
  useAppStore.getState().openLauncher('resume', 'claude');
  await wait(() => projectRequests.length === 2, 'changed provider scan');
  const project = name => ({ encodedPath: name, realPath: `C:\\synthetic\\${name}`, dirName: name, sessionCount: 1, isPinned: false });
  projectRequests[0].resolve([project('Stale provider project')]);
  await settle();
  assert.ok(!host.textContent.includes('Stale provider project'));
  projectRequests[1].resolve([project('Project A'), project('Project B')]);
  await wait(() => host.textContent.includes('Project A'), 'current projects');
  clickText('Project A');
  await wait(() => sessionRequests.length === 1, 'first project scan');
  const back = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Back'));
  back.click();
  await wait(() => host.textContent.includes('Project B'), 'back to projects');
  clickText('Project B');
  await wait(() => sessionRequests.length === 2, 'second project scan');
  const historySession = (title, uuid, cwd) => ({ sessionId: uuid, projectPath: cwd, customTitle: title, firstUserMessage: null, gitBranch: null, lastTimestamp: null });
  sessionRequests[1].resolve([historySession('Current B conversation', 'uuid-b', 'C:\\synthetic\\Project B')]);
  await wait(() => host.textContent.includes('Current B conversation'), 'current project conversations');
  sessionRequests[0].resolve([historySession('Stale A conversation', 'uuid-a', 'C:\\synthetic\\Project A')]);
  await settle();
  assert.ok(!host.textContent.includes('Stale A conversation'));
  clickText('Current B conversation');
  await wait(() => creates.length === 1 && !useAppStore.getState().launcherOpen, 'resume exact current conversation');
  assert.deepEqual(creates[0], { cwd: 'C:\\synthetic\\Project B', cli: 'claude', uuid: 'uuid-b' });
  useAppStore.getState().openLauncher('resume', 'copilot');
  await wait(() => projectRequests.length === 3, 'retry launcher scan');
  projectRequests[2].reject(new Error('Synthetic project read failure'));
  await wait(() => host.querySelector('[role="alert"]'), 'launcher errors visible');
  assert.ok(!host.textContent.includes('No projects found'));
  useAppStore.getState().closeLauncher();
  reactRoot.render(React.createElement(SearchPanel));
  await wait(() => host.querySelector('input[placeholder="Search sessions..."]'), 'search panel mounts');
  input('old query');
  await wait(() => searches.length === 1, 'debounced history search');
  input('');
  await settle();
  searches[0].resolve([{ cli: 'copilot', sessionId: 'old', projectPath: 'C:\\synthetic', projectName: 'Old', snippet: 'STALE_SEARCH_RESULT', role: 'user', timestamp: null }]);
  await settle();
  assert.ok(!host.textContent.includes('STALE_SEARCH_RESULT'), 'cleared queries cannot resurrect old results');
  assert.ok(cancellations.includes('search'));
  input('failed query');
  await wait(() => searches.length === 2, 'second history search');
  searches[1].reject(new Error('Synthetic search read failure'));
  await wait(() => host.querySelector('[role="alert"]'), 'search errors visible');
  assert.ok(!host.textContent.includes('No results'));
  input('current query');
  await wait(() => searches.length === 3, 'third history search');
  searches[2].resolve([{ cli: 'copilot', sessionId: 'current-uuid', projectPath: 'C:\\current', projectName: 'Current', snippet: 'CURRENT_SEARCH_RESULT', role: 'assistant', timestamp: null }]);
  await wait(() => host.textContent.includes('CURRENT_SEARCH_RESULT'), 'new history results still render');
  const result = [...host.querySelectorAll('button')].find(button => button.textContent.includes('CURRENT_SEARCH_RESULT'));
  result.click();
  await wait(() => creates.length === 2, 'search result resumes');
  assert.equal(creates[1].uuid, 'current-uuid');
  input('unmount query');
  await wait(() => searches.length === 4, 'pending search before unmount');
  reactRoot.render(React.createElement('div'));
  await settle();
  searches[3].resolve([]);
  await settle();
  const info = (id, uuid) => ({ id, resumeSessionId: uuid, cli: 'copilot', cwd: 'C:\\templates', status: 'idle', title: 'Same name' });
  useAppStore.setState({ sessions: { a: info('a', 'template-a'), b: info('b', 'template-b') }, displayNames: { a: 'Same name', b: 'Same name' } });
  reactRoot.render(React.createElement(TemplatesPanel));
  await wait(() => host.querySelector('input[placeholder="Template name..."]'), 'template panel mounts');
  input('Synthetic workspace');
  await wait(() => !host.querySelector('button[title="Save current sessions as template"]').disabled, 'template save enabled');
  host.querySelector('button[title="Save current sessions as template"]').click();
  await wait(() => saves.length === 1 && host.querySelector('button[title="Launch template"]'), 'workspace saved');
  assert.deepEqual(saves[0][0].sessions.map(s => s.sessionId), ['template-a', 'template-b']);
  useAppStore.setState({ sessions: { a: info('a', 'template-a') } });
  await settle();
  createGate = deferred();
  const launch = host.querySelector('button[title="Launch template"]');
  launch.click();
  launch.click();
  await wait(() => creates.length === 3, 'one template launch despite repeated click');
  assert.equal(creates[2].uuid, 'template-b');
  createGate.resolve();
  await wait(() => Object.values(useAppStore.getState().sessions).some(s => s.resumeSessionId === 'template-b'), 'missing conversation resumed');
  reactRoot.unmount();
  assert.ok(cancellations.includes('projects') && cancellations.includes('sessions'));
  return { staleProviderAndProjectResponsesIgnored: true, exactConversationResumed: true,
    queryClearAndUnmountSafe: true, visibleHistoryFailures: true, duplicateNamesPreserveTemplateUuids: true,
    duplicateTemplateClicksBlocked: true };
}

let window;
if (owner && !secondary) app.whenReady().then(async () => {
  const stateFile = path.join(root, 'synthetic-restore-state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ owner: 'primary' }));
  const child = spawn(process.execPath, [__filename, '--ownership-secondary'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
  let timeout;
  try {
    const code = await Promise.race([exited, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Secondary Electron launch timed out')), 15000);
    })]);
    assert.equal(code, 0, childOutput);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) { child.kill(); await exited; }
  }
  const deadline = Date.now() + 5000;
  while (focusRequests === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(focusRequests, 1, 'second launch forwards to primary without taking state ownership');
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { owner: 'primary' });
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('about:blank');
  const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))})`);
  console.log(JSON.stringify({ nativeElectronOwnership: true, secondaryCannotReplaceRestoreState: true, ...result }));
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});

const { app, BrowserWindow, ipcMain } = require('electron');
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
    const node = [...host.querySelectorAll('button')].find(node => node.textContent.trim() === text)
      ?? [...host.querySelectorAll('div')].find(node => node.textContent === text && node.closest('.cursor-pointer'));
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
  let failShellWrite = true;
  Object.assign(window.agentPlex, {
    platform: 'win32',
    getShells: async () => [{ id: 'old-shell', label: 'Old shell' }, { id: 'new-shell', label: 'New shell' }],
    getDefaultShell: async () => 'old-shell',
    setDefaultShell: async () => { if (failShellWrite) throw new Error('Synthetic settings write failure'); },
  });
  const assets = Object.fromEntries(['logo', 'claude-logo', 'codex-dark', 'codex-light', 'githubcopilot-dark', 'githubcopilot-light'].map(name => [
    `../../../assets/${name}.svg`, { __esModule: true, default: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>' },
  ]));
  const { Toolbar } = loadSource('src/renderer/components/Toolbar.tsx', { '../store': { useAppStore }, ...assets });
  reactRoot.render(React.createElement(Toolbar));
  await wait(() => host.textContent.includes('New Session'), 'toolbar mounts');
  clickText('New Session');
  const shellButton = name => [...host.querySelectorAll('button')].find(button => button.textContent.trim() === name);
  await wait(() => shellButton('Old shell')?.querySelector('svg'), 'saved default shell selected');
  shellButton('New shell').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await wait(() => host.textContent.includes('Set as default'), 'default shell context menu');
  clickText('Set as default');
  await wait(() => host.querySelector('[role="alert"]'), 'settings write failure visible');
  assert.ok(shellButton('Old shell').querySelector('svg'), 'failed write preserves the displayed default');
  assert.equal(shellButton('New shell').querySelector('svg'), null);
  failShellWrite = false;
  clickText('Set as default');
  await wait(() => shellButton('New shell')?.querySelector('svg') && !host.querySelector('[role="alert"]'), 'retry saves and updates the displayed default');
  reactRoot.render(React.createElement('div'));
  await settle();
  window.agentPlex.getDefaultShell = async () => { throw new Error('Synthetic settings read failure'); };
  reactRoot.render(React.createElement(Toolbar));
  await wait(() => host.querySelector('[role="alert"]')?.textContent.includes('Could not read settings.json'), 'startup settings read failure visible');
  const fs = require('node:fs');
  const cssRoot = path.join(repositoryRoot, '.vite', 'renderer', 'main_window', 'assets');
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(path.join(cssRoot, fs.readdirSync(cssRoot).find(name => /^index-.*\.css$/.test(name))), 'utf8');
  document.head.append(style);
  Object.assign(window.agentPlex, { getShells: async () => [], getDefaultShell: async () => null,
    gitBranchInfo: async () => null, updateSessionState() {} });
  const { ExplorerPanel } = loadSource('src/renderer/components/panels/ExplorerPanel.tsx', {
    '../../store': { useAppStore }, '../AttentionBox': { AttentionBox: () => null },
    ...assets,
    ...Object.fromEntries(Object.entries(assets).map(([name, value]) => [name.replace('../../../', '../../../../'), value])),
  });
  useAppStore.setState({ sessions: {}, nodes: [], displayNames: {}, openPanes: [], nodeCounter: 0 });
  for (let index = 0; index < 30; index++) useAppStore.getState().addSession({
    id: `menu-${index}`, title: `Session ${String(index).padStart(2, '0')}`, status: 'idle', cli: 'copilot',
    cwd: 'C:\\synthetic\\menu', startedAt: Date.now(), lastActivityAt: Date.now(),
  });
  useAppStore.setState(state => ({ nodes: [...state.nodes, ...Array.from({ length: 80 }, (_, index) => ({
    id: `menu-group-${index}`, type: 'groupNode', position: { x: 0, y: 0 },
    data: { label: `Menu group ${index}`, color: '#7aa2f7' },
  }))] }));
  host.style.cssText = 'position:fixed;inset:0;overflow:auto;transform:translateZ(0)';
  reactRoot.render(React.createElement(ExplorerPanel));
  await wait(() => host.textContent.includes('Session 29'), 'explorer menu fixture');
  host.scrollTop = host.scrollHeight;
  const menu = label => document.querySelector(`[role="menu"][aria-label="${label}"]`);
  const inViewport = element => {
    const rect = element.getBoundingClientRect();
    assert.ok(rect.left >= 7 && rect.top >= 7, `menu top/left outside viewport: ${JSON.stringify(rect)}`);
    assert.ok(rect.right <= document.documentElement.clientWidth - 7 && rect.bottom <= document.documentElement.clientHeight - 7,
      `menu bottom/right outside viewport: ${JSON.stringify(rect)}`);
  };
  const clickVisible = element => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert.ok(target && element.contains(target), 'menu option must be unobscured and hit-testable');
    target.click();
  };
  const bottomSession = [...host.querySelectorAll('button')].find(button => button.textContent.includes('Session 29'));
  const openBottomMenu = async () => {
    bottomSession.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true,
      clientX: innerWidth - 3, clientY: innerHeight - 3 }));
    await wait(() => menu('Session actions'), 'session actions at bottom-right');
    inViewport(menu('Session actions'));
    assert.equal(menu('Session actions').parentElement, document.body, 'menu escapes clipped/transformed explorer');
  };
  await openBottomMenu();
  clickVisible([...menu('Session actions').querySelectorAll('button')].find(button => button.textContent.includes('Rename')));
  await wait(() => bottomSession.querySelector('input'), 'rename remains selectable at bottom of window');
  bottomSession.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !bottomSession.querySelector('input'), 'cancel rename');
  await openBottomMenu();
  const { ipcRenderer } = require('electron');
  await ipcRenderer.invoke('test:menu-window-size', 500, 300);
  await settle();
  inViewport(menu('Session actions'));
  const groupButton = [...menu('Session actions').querySelectorAll('button')].find(button => button.textContent.includes('Add to group'));
  groupButton.parentElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(() => menu('Session groups'), 'group submenu opens');
  inViewport(menu('Session groups'));
  assert.ok(menu('Session groups').getBoundingClientRect().right <= menu('Session actions').getBoundingClientRect().left + 1,
    'submenu flips left at the right edge');
  menu('Session groups').scrollTop = menu('Session groups').scrollHeight;
  await settle();
  const lastGroup = [...menu('Session groups').querySelectorAll('button')].find(button => button.textContent === 'Menu group 79');
  clickVisible(lastGroup);
  await wait(() => useAppStore.getState().nodes.find(node => node.id === 'menu-29').parentId === 'menu-group-79', 'last scrollable group selectable');
  const menuProject = [...host.querySelectorAll('button')].find(button => button.title === 'C:\\synthetic\\menu');
  menuProject.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 }));
  await wait(() => menu('Project actions'), 'directory actions at bottom edge');
  inViewport(menu('Project actions'));
  menu('Project actions').scrollTop = menu('Project actions').scrollHeight;
  await settle();
  const folder = [...menu('Project actions').querySelectorAll('button')].find(button => button.textContent.includes('Open Folder'));
  const folderRect = folder.getBoundingClientRect();
  assert.ok(folderRect.bottom <= innerHeight - 7, 'last project action remains reachable');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(() => !menu('Project actions'), 'Escape dismisses menu');
  const { SessionNode } = loadSource('src/renderer/components/SessionNode.tsx', {
    '../store': { useAppStore }, '@xyflow/react': { Handle: () => null, Position: { Top: 'top', Bottom: 'bottom' } }, ...assets,
  });
  host.style.cssText = 'position:fixed;inset:0;overflow:auto';
  reactRoot.render(React.createElement(SessionNode, { id: 'menu-0', data: {
    sessionId: 'menu-0', label: 'Graph session', status: 'idle', tasks: [], plans: [], mode: 'normal',
  } }));
  await wait(() => host.textContent.includes('Graph session'), 'graph session fixture');
  host.firstElementChild.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 }));
  await wait(() => menu('Session project actions'), 'graph menu at bottom-right');
  inViewport(menu('Session project actions'));
  const graphGroup = [...menu('Session project actions').querySelectorAll('button')].find(button => button.textContent.includes('Add to group'));
  graphGroup.parentElement.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  await wait(() => menu('Session groups'), 'graph group submenu');
  inViewport(menu('Session groups'));
  menu('Session groups').dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 100 }));
  await settle();
  assert.ok(menu('Session groups'), 'scrolling inside graph menu must not dismiss it');
  menu('Session groups').scrollTop = menu('Session groups').scrollHeight;
  await settle();
  clickVisible([...menu('Session groups').querySelectorAll('button')].find(button => button.textContent === 'Menu group 79'));
  await wait(() => useAppStore.getState().nodes.find(node => node.id === 'menu-0').parentId === 'menu-group-79', 'graph group remains selectable');
  const { ReactFlow, ReactFlowProvider } = require(require.resolve('@xyflow/react', { paths: [repositoryRoot] }));
  document.documentElement.dataset.theme = 'dark';
  useAppStore.getState().flashMessageEdge('theme-source', 'theme-target');
  const messageEdge = useAppStore.getState().edges.find(edge => edge.source === 'theme-source');
  reactRoot.render(React.createElement(ReactFlowProvider, null, React.createElement(ReactFlow, {
    nodes: ['theme-source', 'theme-target'].map((id, index) => ({ id, position: { x: 30 + index * 220, y: 50 + index * 80 }, data: { label: id } })),
    edges: [messageEdge],
  })));
  await wait(() => host.querySelector('.react-flow__edge-path[marker-end]') && host.querySelector('marker polyline'), 'real message SVG and arrow');
  const messagePath = host.querySelector('.react-flow__edge-path[marker-end]');
  const arrow = host.querySelector('marker polyline');
  assert.notEqual(getComputedStyle(messagePath).markerEnd, 'none', 'CSS-variable marker IDs must produce valid SVG references');
  assert.equal(getComputedStyle(messagePath).stroke, 'rgb(176, 193, 207)');
  assert.equal(getComputedStyle(arrow).fill, 'rgb(176, 193, 207)');
  document.documentElement.dataset.theme = 'light';
  assert.equal(getComputedStyle(messagePath).stroke, 'rgb(93, 112, 100)', 'existing message edges follow theme changes');
  assert.equal(getComputedStyle(arrow).fill, 'rgb(93, 112, 100)', 'existing arrowheads follow theme changes');
  reactRoot.unmount();
  assert.ok(cancellations.includes('projects') && cancellations.includes('sessions'));
  return { staleProviderAndProjectResponsesIgnored: true, exactConversationResumed: true,
    queryClearAndUnmountSafe: true, visibleHistoryFailures: true, duplicateNamesPreserveTemplateUuids: true,
    duplicateTemplateClicksBlocked: true, settingsReadAndWriteFailuresVisible: true, failedShellChangesPreserveSelection: true,
    bottomEdgeMenusContained: true, resizeRepositionsMenus: true, nestedGroupsFlipAndScroll: true, graphMenusContained: true,
    liveThemedMessageArrows: true };
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
  ipcMain.handle('test:menu-window-size', (_event, width, height) => window.setContentSize(width, height));
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

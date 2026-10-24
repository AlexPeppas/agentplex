const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

// Renders the real SessionNode card and checks its send and Duplicate Session actions.
async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [repositoryRoot] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [repositoryRoot] }));
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const store = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const { useAppStore } = store;
  const stub = () => null;
  const { SessionNode } = loadSource('src/renderer/components/SessionNode.tsx', {
    '../store': store,
    '@xyflow/react': { Handle: stub, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' } },
    './CliIcon': { CliIcon: stub },
    './StatusIndicator': { StatusIndicator: stub },
    './SessionMetrics': { ContextMeter: stub, SessionAge: stub },
  });

  const errors = [];
  console.error = (...args) => errors.push(args.map(String).join(' '));
  const forkCalls = [];
  let resolveFork;
  window.agentPlex = {
    platform: 'win32',
    gitBranchInfo: () => Promise.resolve(null),
    forkSession: id => {
      forkCalls.push(id);
      return new Promise(resolve => { resolveFork = resolve; });
    },
  };

  const session = (id, extra = {}) => ({ id, title: id, status: 'idle', cli: 'claude', cwd: 'C:\\work', ...extra });
  const setSessions = (...list) => useAppStore.setState({ sessions: Object.fromEntries(list.map(s => [s.id, s])) });
  const nodeData = id => ({ label: id, sessionId: id, status: 'idle', mode: 'normal', plans: [], tasks: [] });

  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  const render = id => reactRoot.render(React.createElement(SessionNode, { id, data: nodeData(id) }));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const button = prefix => [...host.querySelectorAll('button')].find(b => b.title.startsWith(prefix));
  const sendButton = () => button('Send message') || button('No other active session');
  const duplicateButton = () => button('Duplicate Session');
  const results = {};

  // Send: disabled with an explanation until another writable, live session exists.
  setSessions(session('a', { resumeSessionId: '33333333-3333-4333-8333-333333333333' }));
  render('a');
  await wait(() => sendButton(), 'card renders');
  assert.equal(sendButton().disabled, true);
  assert.match(sendButton().title, /No other active session to send to/);
  setSessions(session('a'), session('b'));
  await wait(() => !sendButton().disabled, 'send enables with a second session');
  assert.equal(sendButton().title, 'Send message to another session');
  setSessions(session('a'), session('b', { readOnly: true }));
  await wait(() => sendButton().disabled, 'read-only CLIs are not targets');
  setSessions(session('a'), session('b', { status: 'killed' }));
  await wait(() => sendButton().disabled, 'ended sessions are not targets');
  results.sendDisabledWithoutTargets = true;

  // Duplicate: enabled for Claude sessions, with or without a saved conversation.
  setSessions(session('a'));
  await wait(() => duplicateButton() && !duplicateButton().disabled, 'duplicate enabled for Claude');
  assert.equal(duplicateButton().title, 'Duplicate Session');
  setSessions(session('a', { cli: 'claude-resume' }));
  await wait(() => !duplicateButton().disabled, 'duplicate enabled for claude --resume sessions');
  setSessions(session('a', { cli: 'copilot' }));
  await wait(() => duplicateButton().disabled, 'duplicate disabled for Copilot');
  assert.equal(duplicateButton().title, 'Duplicate Session is available for Claude sessions.');
  results.duplicateAvailability = true;

  // Clicking forks once, ignores repeat clicks while pending, then adds the copy to the graph.
  setSessions(session('a'));
  await wait(() => !duplicateButton().disabled, 'duplicate re-enabled');
  duplicateButton().click();
  duplicateButton().click();
  await wait(() => forkCalls.length > 0, `fork requested ${errors.join('\n')}`);
  await wait(() => duplicateButton().disabled, 'disabled while duplicating');
  assert.deepEqual(forkCalls, ['a'], 'repeat clicks do not fork twice');
  resolveFork(session('a-copy', { pid: 1, startedAt: Date.now() }));
  await wait(() => useAppStore.getState().sessions['a-copy'], 'copy added to the store');
  assert.ok(useAppStore.getState().nodes.some(n => n.id === 'a-copy'), 'copy added to the graph');
  await wait(() => !duplicateButton().disabled, 're-enabled after duplicating');
  assert.equal(useAppStore.getState().openPanes.includes('a'), false, 'clicking does not select the source card');
  results.duplicateForksOnce = true;

  reactRoot.unmount();
  return results;
}

let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await window.loadURL('about:blank');
  const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))})`);
  console.log(JSON.stringify(result));
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});

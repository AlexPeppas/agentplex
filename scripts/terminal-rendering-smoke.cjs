// Run via node scripts/run-git-editor-e2e.cjs terminal-rendering-smoke.cjs.
// Uses an isolated hidden window and synthetic
// output only; never connects to AgentPlex or a real session.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through the external Electron E2E launcher');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

async function rendererTest(root) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const fs = require('node:fs');
  const fromRoot = name => require(require.resolve(name, { paths: [root] }));
  const React = fromRoot('react');
  const { createRoot } = fromRoot('react-dom/client');
  const { Terminal } = fromRoot('@xterm/xterm');
  const { loadSource } = require(path.join(root, 'scripts', 'test-support.cjs'));
  const style = document.createElement('style');
  style.textContent = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css', { paths: [root] }), 'utf8') + `
    * { box-sizing: border-box; } body { margin: 0; }
    .flex { display: flex; } .flex-col { flex-direction: column; }
    .flex-1 { flex: 1 1 0%; } .shrink-0 { flex-shrink: 0; }
    .min-h-0 { min-height: 0; } .min-w-0 { min-width: 0; }
    .h-full { height: 100%; } .w-full { width: 100%; }
    .overflow-hidden { overflow: hidden; } .p-1 { padding: 4px; }
    .min-h-9 { min-height: 36px; } button { height: 30px; }
  `;
  document.head.append(style);
  const terminals = [];
  const sizes = [];
  let output;
  window.agentPlex = {
    platform: 'win32', onZoom: () => () => {},
    onSessionData: callback => { output = callback; return () => { output = null; }; },
    resizeSession: (id, cols, rows) => sizes.push({ id, cols, rows }),
    writeSession: () => { throw new Error('Test must not send session input'); },
    gitBranchInfo: async () => null,
  };
  const state = {
    sessions: { demo: { id: 'demo', title: 'Demo', cli: 'copilot', status: 'idle',
      cwd: 'C:\\demo', startedAt: Date.now(), lastActivityAt: Date.now(),
      windowsPty: { backend: 'conpty', buildNumber: 26100 } } },
    sessionBuffers: {}, buffersReady: false, displayNames: {}, openPanes: ['demo'], activePaneId: 'demo',
    terminalFullscreen: false, openPane() {}, closePane() {},
    toggleTerminalFullscreen() { state.terminalFullscreen = !state.terminalFullscreen; render(); },
  };
  const store = selector => selector(state);
  store.getState = () => state;
  const overrides = {
    '../store': { useAppStore: store },
    '@xterm/xterm': { Terminal: class extends Terminal {
      constructor(options) { super(options); terminals.push(this); }
    } },
    '@xterm/xterm/css/xterm.css': {},
    '../monaco-theme': { defineAgentPlexTheme() {} },
    './GitDiffPanel': { GitDiffPanel: () => React.createElement('div', null, 'Git') },
  };
  for (const asset of ['claude-logo', 'codex-dark', 'codex-light', 'githubcopilot-dark', 'githubcopilot-light']) {
    overrides[`../../../assets/${asset}.svg`] = '';
  }
  const { TerminalPanel } = loadSource('src/renderer/components/TerminalPanel.tsx', overrides);
  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  function render() {
    host.style.width = state.terminalFullscreen ? '1100px' : '480px';
    host.style.height = state.terminalFullscreen ? '650px' : '330px';
    reactRoot.render(React.createElement(TerminalPanel));
  }
  const wait = () => new Promise(resolve => setTimeout(resolve, 100));
  render();
  await wait();
  assert.equal(terminals.length, 0, 'a pane opened during hydration must defer mounting');
  state.sessionBuffers.demo = 'HYDRATED_HISTORY\r\n';
  state.buffersReady = true;
  render();
  await wait();
  const term = terminals[0];
  assert.ok(term);
  await new Promise(resolve => term.write('', resolve));
  assert.equal(term.buffer.active.getLine(0).translateToString(true), 'HYDRATED_HISTORY');
  assert.deepEqual(term.options.windowsPty, { backend: 'conpty', buildNumber: 26100 });
  output({ id: 'demo', data: Array.from({ length: 90 }, (_, i) => `Chat line ${i}: ${'wrapped text '.repeat(10)}\r\n`).join('') });
  await wait();
  const check = () => {
    assert.equal(terminals.length, 1, 'fullscreen must not recreate or replay the terminal');
    const viewport = term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const available = term.element.parentElement.getBoundingClientRect();
    assert.ok(viewport.bottom <= available.bottom + 1, 'terminal rows must fit without clipping');
    assert.ok(viewport.right <= available.right + 1, 'terminal columns must fit without clipping');
    assert.equal(sizes.at(-1).cols, term.cols);
    assert.equal(sizes.at(-1).rows, term.rows);
    assert.ok(term.cols > 20 && term.rows > 5);
  };
  check();
  const initial = { cols: term.cols, rows: term.rows };
  for (let i = 0; i < 12; i++) {
    host.querySelector(`button[title="${state.terminalFullscreen ? 'Exit fullscreen' : 'Fullscreen'}"]`).click();
    output({ id: 'demo', data: `\r\nLive output ${i}\r\n` });
    await wait();
    check();
    if (!state.terminalFullscreen) assert.deepEqual({ cols: term.cols, rows: term.rows }, initial);
  }
  const gitButton = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === 'Git');
  gitButton.click();
  await wait();
  const count = sizes.length;
  state.terminalFullscreen = true;
  render();
  await wait();
  assert.equal(sizes.length, count, 'hidden git-tab terminal must not resize');
  [...host.querySelectorAll('button')].find(button => button.textContent.includes('Demo')).click();
  await wait();
  check();
  reactRoot.unmount();
  assert.equal(output, null);

  // Demonstrate the underlying ConPTY row-growth mismatch with real xterm.
  async function rowGrowth(windowsPty) {
    const el = document.createElement('div');
    document.body.append(el);
    const sample = new Terminal({ cols: 40, rows: 5, windowsPty });
    sample.open(el);
    await new Promise(resolve => sample.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix', resolve));
    const before = sample.buffer.active.baseY;
    sample.resize(40, 8);
    const after = sample.buffer.active.baseY;
    sample.dispose();
    el.remove();
    return { before, after };
  }
  const oldBehavior = await rowGrowth(undefined);
  const fixedBehavior = await rowGrowth({ backend: 'conpty', buildNumber: 26100 });
  assert.ok(oldBehavior.after < oldBehavior.before, 'reproduce scrollback pulled into viewport');
  assert.equal(fixedBehavior.after, fixedBehavior.before, 'ConPTY scrollback must stay in history');
  return { fullscreenTransitions: 12, dimensionsRestored: initial, hiddenTabRecovery: true, oldBehavior, fixedBehavior };
}

let window;
app.whenReady().then(async () => {
  window = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
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

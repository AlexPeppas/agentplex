// Run with node. Launches an isolated hidden Electron window that mounts the
// real TerminalPanel with the app's bundled web font declared exactly like
// styles/index.css. The pane mounts before the font has loaded, so the first
// fit measures the fallback font: every row must still fit inside the pane
// once xterm has measured the real font, both right away and after
// document.fonts settles.
const electron = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-font-test-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(electron, [__filename, profile], { env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
} else {
  runElectron();
}

async function rendererTest(root) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const fs = require('node:fs');
  const fromRoot = name => require(require.resolve(name, { paths: [root] }));
  const React = fromRoot('react');
  const { createRoot } = fromRoot('react-dom/client');
  const { Terminal } = fromRoot('@xterm/xterm');
  const { FitAddon } = fromRoot('@xterm/addon-fit');
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
    .terminal-pane { container: terminal-pane / inline-size; }
    .workspace-explorer { display: none; }
  `;
  document.head.append(style);
  const FONT = '14px "MesloLGS Nerd Font Mono"';
  assert.equal(document.fonts.check(FONT), false, 'the bundled font must not be loaded before the pane mounts');
  const terminals = [];
  const sizes = [];
  const listeners = new Set();
  window.agentPlex = {
    platform: process.platform, onZoom: () => () => {},
    onSessionData: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    resizeSession: (id, cols, rows) => sizes.push({ id, cols, rows }),
    writeSession: () => {},
    gitBranchInfo: async () => null,
    listWorkspaceDirectory: async () => ({ entries: [], truncated: false }),
  };
  const state = {
    sessions: { demo: { id: 'demo', title: 'Demo', cli: 'claude', status: 'running',
      cwd: root, startedAt: Date.now(), lastActivityAt: Date.now() } },
    sessionBuffers: {}, sessionBufferOffsets: {}, buffersReady: true, displayNames: {}, openPanes: ['demo'], activePaneId: 'demo',
    terminalFullscreen: false, openPane() {}, closePane() {}, toggleTerminalFullscreen() {},
  };
  const store = selector => selector(state);
  store.getState = () => state;
  const overrides = {
    '../store': { useAppStore: store },
    '@xterm/addon-fit': { FitAddon },
    '@xterm/xterm': { Terminal: class extends Terminal { constructor(options) { super(options); terminals.push(this); } } },
    '@xterm/xterm/css/xterm.css': {},
    '../monaco-theme': { defineAgentPlexTheme() {} },
    './GitDiffPanel': { GitDiffPanel: () => React.createElement('div', null, 'Git') },
    './ArtifactPreview': { ArtifactPreview: () => React.createElement('div', null, 'Artifact') },
  };
  for (const asset of ['claude-logo', 'codex-dark', 'codex-light', 'githubcopilot-dark', 'githubcopilot-light']) {
    overrides[`../../../assets/${asset}.svg`] = '';
  }
  const { TerminalPanel } = loadSource('src/renderer/components/TerminalPanel.tsx', overrides);
  const host = document.createElement('div');
  host.style.width = '1040px';
  host.style.height = '900px';
  document.body.append(host);
  createRoot(host).render(React.createElement(TerminalPanel));
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const deadline = Date.now() + 8000;
  while (sizes.length === 0) {
    assert.ok(Date.now() < deadline, 'the pane must size its PTY');
    await wait(25);
  }
  const term = terminals[0];
  const geometry = label => {
    const rows = [...term.element.querySelectorAll('.xterm-rows > div')];
    const container = term.element.parentElement.getBoundingClientRect();
    const clipped = rows.filter(row => row.getBoundingClientRect().bottom > container.bottom + 0.5).length;
    // The DOM renderer sizes every row to the cell height xterm measured.
    const cellHeight = rows[0].getBoundingClientRect().height;
    return { label, cols: term.cols, rows: term.rows, cellHeight, domRows: rows.length,
      containerHeight: Math.round(container.height), clipped, sent: sizes.at(-1), fontLoaded: document.fonts.check(FONT) };
  };
  const check = snapshot => {
    assert.equal(snapshot.clipped, 0, `every row must stay inside the pane: ${JSON.stringify(snapshot)}`);
    assert.ok(snapshot.rows * snapshot.cellHeight <= snapshot.containerHeight,
      `rows must be computed from the measured cell: ${JSON.stringify(snapshot)}`);
    assert.deepEqual({ cols: snapshot.sent.cols, rows: snapshot.sent.rows }, { cols: snapshot.cols, rows: snapshot.rows },
      `the PTY must receive the final geometry: ${JSON.stringify(snapshot)}`);
  };
  const snapshots = [];
  // Let the resize controller settle (100ms) and xterm re-measure after the resize.
  await wait(400);
  snapshots.push(geometry('after-first-fit'));
  check(snapshots.at(-1));
  await document.fonts.ready;
  await Promise.all([document.fonts.load(FONT), document.fonts.load(`bold ${FONT}`)]);
  await wait(600);
  snapshots.push(geometry('after-font-load'));
  assert.equal(snapshots.at(-1).fontLoaded, true, 'the bundled font must load');
  check(snapshots.at(-1));
  // The real font is taller than the fallback: the pane must have shrunk its rows.
  const fallbackRows = Math.floor((snapshots.at(-1).containerHeight - 8) / 16);
  assert.ok(snapshots.at(-1).rows < fallbackRows, `rows must follow the loaded font, not the fallback: ${JSON.stringify(snapshots.at(-1))}`);
  return snapshots;
}

function runElectron() {
  const { app, BrowserWindow } = electron;
  app.setPath('userData', process.argv[2]);
  app.disableHardwareAcceleration();
  const root = path.resolve(__dirname, '..');
  const fontDir = path.join(root, 'assets', 'fonts');
  const page = path.join(process.argv[2], 'font-test.html');
  // Same @font-face declarations as styles/index.css, resolved to the bundled files.
  fs.writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: 'MesloLGS Nerd Font Mono'; src: url('${toFileUrl(path.join(fontDir, 'MesloLGSNerdFontMono-Regular.ttf'))}') format('truetype'); font-weight: 400; font-style: normal; }
    @font-face { font-family: 'MesloLGS Nerd Font Mono'; src: url('${toFileUrl(path.join(fontDir, 'MesloLGSNerdFontMono-Bold.ttf'))}') format('truetype'); font-weight: 700; font-style: normal; }
  </style></head><body></body></html>`);
  let window;
  app.whenReady().then(async () => {
    window = new BrowserWindow({ show: false, width: 1400, height: 1000,
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true, webSecurity: false } });
    await window.loadFile(page);
    const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(root)})`);
    console.log(JSON.stringify(result));
    window.destroy();
    app.quit();
  }).catch(error => {
    console.error(error);
    if (window && !window.isDestroyed()) window.destroy();
    app.exit(1);
  });
}

function toFileUrl(file) {
  return 'file://' + (process.platform === 'win32' ? '/' + file.replace(/\\/g, '/') : file);
}

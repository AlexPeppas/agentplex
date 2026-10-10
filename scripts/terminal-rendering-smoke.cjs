// Run with node. Launches an isolated hidden Electron window with synthetic
// output and test-owned PTYs only; never connects to AgentPlex or user sessions.
const electron = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-render-test-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(electron, [__filename, profile], { env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    // Chromium may hold profile files until the process has fully exited.
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
  `;
  document.head.append(style);
  const terminals = [];
  const fits = new Map();
  const sizes = [];
  const listeners = new Set();
  const nativePtys = new Map();
  const { ipcRenderer } = require('electron');
  const output = event => {
    state.sessionBuffers[event.id] = ((state.sessionBuffers[event.id] ?? '') + event.data).slice(-512 * 1024);
    listeners.forEach(callback => callback(event));
  };
  const onNativeData = (_event, event) => output(event);
  ipcRenderer.on('test:pty-data', onNativeData);
  window.agentPlex = {
    platform: 'win32', onZoom: () => () => {},
    onSessionData: callback => { listeners.add(callback); return () => listeners.delete(callback); },
    resizeSession: (id, cols, rows) => {
      sizes.push({ id, cols, rows });
      nativePtys.get(id)?.resize(cols, rows);
    },
    writeSession: (id, data) => {
      assert.match(data, /^\x1b\[\d+;\d+R$/, 'only cursor-position responses may reach test PTYs');
      nativePtys.get(id)?.write(data);
    },
    gitBranchInfo: async () => null,
  };
  const state = {
    sessions: { demo: { id: 'demo', title: 'Demo', cli: 'copilot', status: 'idle',
      cwd: 'C:\\demo', startedAt: Date.now(), lastActivityAt: Date.now(),
      windowsPty: { backend: 'conpty', buildNumber: 26100 } } },
    sessionBuffers: {}, displayNames: {}, openPanes: ['demo'], activePaneId: 'demo',
    terminalFullscreen: false, openPane() {}, closePane() {},
    toggleTerminalFullscreen() { state.terminalFullscreen = !state.terminalFullscreen; render(); },
  };
  const store = selector => selector(state);
  store.getState = () => state;
  const overrides = {
    '../store': { useAppStore: store },
    '@xterm/addon-fit': { FitAddon: class extends FitAddon {
      activate(term) { super.activate(term); fits.set(term, this); }
    } },
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
  let reactRoot = createRoot(host);
  function render() {
    host.style.width = state.terminalFullscreen ? '1100px' : '480px';
    host.style.height = state.terminalFullscreen ? '650px' : '330px';
    reactRoot.render(React.createElement(TerminalPanel));
  }
  const wait = (ms = 220) => new Promise(resolve => setTimeout(resolve, ms));
  const activeTerminals = () => terminals.filter(candidate => candidate.element?.isConnected);
  const waitForLayout = async () => {
    await wait(180);
    const deadline = Date.now() + 8000;
    while (true) {
      const active = activeTerminals();
      if (active.length === state.openPanes.length && active.every((candidate, i) => {
        const dims = fits.get(candidate).proposeDimensions();
        const size = sizes.findLast(entry => entry.id === state.openPanes[i]);
        // DOM-renderer cell width is rounded again after resize; one column of
        // proposal drift is harmless provided the actual screen fits below.
        return dims && Math.abs(dims.cols - candidate.cols) <= 1 && dims.rows === candidate.rows &&
          size?.cols === candidate.cols && size?.rows === candidate.rows;
      })) return;
      assert.ok(Date.now() < deadline, `terminal layout must settle within 8 seconds: ${JSON.stringify(
        active.map((candidate, i) => ({ id: state.openPanes[i], cols: candidate.cols, rows: candidate.rows,
          proposed: fits.get(candidate).proposeDimensions(),
          sent: sizes.findLast(entry => entry.id === state.openPanes[i]) })))}`);
      await wait(25);
    }
  };
  render();
  await waitForLayout();
  const term = terminals[0];
  assert.ok(term);
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
    await waitForLayout();
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
  await waitForLayout();
  check();
  // Opening/closing panes must preserve surviving terminal instances. Drag at
  // frame cadence while output streams, not just between leisurely resizes.
  let stressTransitions = 0;
  const checkAll = () => {
    const active = activeTerminals();
    assert.equal(active.length, state.openPanes.length);
    active.forEach((candidate, i) => {
      const viewport = candidate.element.querySelector('.xterm-screen').getBoundingClientRect();
      const available = candidate.element.parentElement.getBoundingClientRect();
      assert.ok(viewport.bottom <= available.bottom + 1,
        `pane ${state.openPanes[i]} rows ${candidate.rows}: screen ${viewport.height}, container ${available.height}`);
      assert.ok(viewport.right <= available.right + 1,
        `pane ${state.openPanes[i]} cols ${candidate.cols}: screen ${viewport.width}, container ${available.width}`);
      const size = sizes.findLast(entry => entry.id === state.openPanes[i]);
      assert.deepEqual({ cols: candidate.cols, rows: candidate.rows }, { cols: size.cols, rows: size.rows });
      assert.ok(candidate.cols >= 2 && candidate.rows >= 1);
    });
  };
  for (const paneCount of [1, 2, 3, 2, 1]) {
    for (let i = 1; i < paneCount; i++) {
      const id = `demo${i}`;
      state.sessions[id] = { ...state.sessions.demo, id, title: id };
    }
    state.openPanes = ['demo', ...Array.from({ length: paneCount - 1 }, (_, i) => `demo${i + 1}`)];
    render();
    await waitForLayout();
    assert.equal(activeTerminals()[0], term, 'pane changes must not replay surviving terminals');
    checkAll();
    for (let round = 0; round < 4; round++) {
      const count = sizes.length;
      for (let step = 0; step < 18; step++) {
        host.style.width = `${360 + ((step * 71 + round * 37) % 700)}px`;
        host.style.height = `${220 + ((step * 43) % 440)}px`;
        for (const id of state.openPanes) {
          output({ id, data: `\r\n${id} live ${round}:${step} ${'wrapping '.repeat(15)}\r\n` });
        }
        await wait(16);
        stressTransitions++;
      }
      assert.equal(sizes.length, count, 'drag must not resize PTYs at transient geometries');
      await waitForLayout();
      checkAll();
      state.toggleTerminalFullscreen();
      await waitForLayout();
      checkAll();
      stressTransitions++;
    }
  }
  assert.equal(listeners.size, 1, 'closed panes must unsubscribe');
  reactRoot.unmount();
  assert.equal(listeners.size, 0);

  let nativeFrames = 0;
  if (process.platform === 'win32') {
    reactRoot = createRoot(host);
    const buildNumber = Number(require('node:os').release().split('.')[2]);
    const child = `
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let previousGeometry = '';
      process.stdin.on('data', data => {
        if (data.includes('q')) process.exit(0);
        if (data.includes('a')) {
          process.stdout.write('\\x1b[?1049h');
          previousGeometry = '';
        }
      });
      process.stdout.write('\\x1b[?25l');
      setInterval(() => {
        const [cols, rows] = process.stdout.getWindowSize();
        const geometry = cols + 'x' + rows;
        let frame = '';
        // Full draw only on resize; otherwise update the last row like a TUI
        // footer. Repainting everything continually would conceal corruption.
        for (let row = previousGeometry === geometry ? rows : 1; row <= rows; row++) {
          const text = ('ROW' + row + ' ' + cols + 'x' + rows + ' ').padEnd(cols - 1, String(row % 10));
          frame += '\\x1b[' + row + ';1H' + text.slice(0, cols - 1) + '\\x1b[K';
        }
        previousGeometry = geometry;
        process.stdout.write(frame + '\\x1b[' + rows + ';1H');
      }, 30);
    `;
    try {
      state.openPanes = ['native0', 'native1', 'native2'];
      for (const id of state.openPanes) {
        state.sessions[id] = { ...state.sessions.demo, id, title: id,
          windowsPty: { backend: 'conpty', buildNumber } };
        await ipcRenderer.invoke('test:pty-spawn', id, child);
        const native = {
          resize: (cols, rows) => ipcRenderer.send('test:pty-resize', id, cols, rows),
          write: data => ipcRenderer.send('test:pty-write', id, data),
          kill: () => ipcRenderer.invoke('test:pty-kill', id),
        };
        nativePtys.set(id, native);
      }
      render();
      await waitForLayout();
      const startupDeadline = Date.now() + 10000;
      while (state.openPanes.some(id => !state.sessionBuffers[id]?.includes('ROW'))) {
        assert.ok(Date.now() < startupDeadline, 'test PTYs must produce their initial frame');
        await wait(50);
      }
      let expectedBuffer = 'normal';
      const checkNative = async () => {
        await waitForLayout();
        await wait();
        checkAll();
        for (const candidate of activeTerminals()) {
          await new Promise(resolve => candidate.write('', resolve));
          const buffer = candidate.buffer.active;
          assert.equal(buffer.type, expectedBuffer);
          for (let row = 1; row <= candidate.rows; row++) {
            const expected = (`ROW${row} ${candidate.cols}x${candidate.rows} `)
              .padEnd(candidate.cols - 1, String(row % 10)).slice(0, candidate.cols - 1);
            assert.equal(buffer.getLine(buffer.viewportY + row - 1).translateToString(false, 0, candidate.cols).trimEnd(), expected,
              `native TUI row ${row} must match the current geometry`);
          }
          // Check the DOM renderer too, not only xterm's parsed buffer.
          const renderedRows = [...candidate.element.querySelectorAll('.xterm-rows > div')];
          assert.equal(renderedRows.length, candidate.rows);
          for (let row = 0; row < candidate.rows; row++) {
            assert.equal(renderedRows[row].textContent.replace(/\u00a0/g, ' ').slice(0, candidate.cols).trimEnd(),
              buffer.getLine(buffer.viewportY + row).translateToString(false, 0, candidate.cols).trimEnd());
          }
          nativeFrames++;
        }
      };
      await checkNative();
      for (const paneCount of [3, 2, 1, 2, 3]) {
        state.openPanes = Array.from({ length: paneCount }, (_, i) => `native${i}`);
        render();
        await checkNative();
        for (let round = 0; round < 3; round++) {
          for (let step = 0; step < 18; step++) {
            host.style.width = `${390 + ((step * 89 + round * 57) % 700)}px`;
            host.style.height = `${210 + ((step * 47) % 450)}px`;
            await wait(16);
          }
          await checkNative();
          state.toggleTerminalFullscreen();
          await checkNative();
        }
      }
      expectedBuffer = 'alternate';
      for (const id of state.openPanes) ipcRenderer.send('test:pty-write', id, 'a');
      for (let round = 0; round < 6; round++) {
        state.toggleTerminalFullscreen();
        await checkNative();
        host.style.width = `${420 + round * 95}px`;
        host.style.height = `${250 + round * 53}px`;
        await checkNative();
      }
    } finally {
      reactRoot.unmount();
      await Promise.all([...nativePtys.values()].map(native => native.kill()));
      nativePtys.clear();
      ipcRenderer.removeListener('test:pty-data', onNativeData);
    }
  }

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
  return { fullscreenTransitions: 12, stressTransitions, nativeFrames, dimensionsRestored: initial,
    hiddenTabRecovery: true, oldBehavior, fixedBehavior };
}

function runElectron() {
const { app, BrowserWindow, ipcMain } = electron;
app.setPath('userData', process.argv[2]);
app.disableHardwareAcceleration();
let window;
const nativePtys = new Map();
const stopNativePtys = () => {
  for (const native of nativePtys.values()) native.kill();
  nativePtys.clear();
};
app.whenReady().then(async () => {
  const nodeExecutable = require('node:child_process').execFileSync('node', ['-p', 'process.execPath'],
    { encoding: 'utf8', windowsHide: true }).trim();
  ipcMain.handle('test:pty-spawn', (event, id, child) => {
    const native = require('node-pty').spawn(nodeExecutable, ['-e', child], {
      cols: 80, rows: 24, cwd: path.resolve(__dirname, '..'),
      env: { ...process.env },
    });
    nativePtys.set(id, native);
    native.onData(data => {
      if (!event.sender.isDestroyed()) event.sender.send('test:pty-data', { id, data });
    });
  });
  ipcMain.on('test:pty-resize', (_event, id, cols, rows) => nativePtys.get(id).resize(cols, rows));
  ipcMain.on('test:pty-write', (_event, id, data) => nativePtys.get(id).write(data));
  ipcMain.handle('test:pty-kill', async (_event, id) => {
    const native = nativePtys.get(id);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        native.kill();
        reject(new Error(`Test PTY ${id} did not shut down`));
      }, 10000);
      native.onExit(() => { clearTimeout(timer); resolve(); });
      native.write('q');
    });
    nativePtys.delete(id);
  });
  window = new BrowserWindow({ show: false, width: 1200, height: 800,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true } });
  await window.loadURL('about:blank');
  const result = await window.webContents.executeJavaScript(`(${rendererTest.toString()})(${JSON.stringify(path.resolve(__dirname, '..'))})`);
  console.log(JSON.stringify(result));
  stopNativePtys();
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  stopNativePtys();
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
});
}

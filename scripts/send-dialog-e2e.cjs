const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.AGENTPLEX_EDITOR_E2E_ROOT;
if (!root || !fs.existsSync(root)) throw new Error('Run through scripts/run-git-editor-e2e.cjs');
app.setPath('userData', path.join(root, 'profile'));
app.disableHardwareAcceleration();

async function rendererTest(repositoryRoot) {
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const React = require(require.resolve('react', { paths: [repositoryRoot] }));
  const { createRoot } = require(require.resolve('react-dom/client', { paths: [repositoryRoot] }));
  const { loadSource } = require(path.join(repositoryRoot, 'scripts', 'test-support.cjs'));
  const { useAppStore, isSendTarget } = loadSource('src/renderer/store.ts', {
    './components/panels/SettingsPanel': { getSplitPaneEnabled: () => false },
  });
  const calls = [], writes = [];
  let resolveSummary;
  window.agentPlex = {
    platform: 'win32',
    summarizeContext: (id, label) => {
      calls.push({ id, label });
      return new Promise(resolve => { resolveSummary = resolve; });
    },
    writeSession: (id, data) => writes.push({ id, data }),
  };
  const source = { id: 'source', title: 'Source', status: 'idle', cli: 'copilot' };
  const target = { id: 'target', title: 'Target', status: 'idle', cli: 'claude' };
  const open = cli => useAppStore.setState({
    sendDialogSourceId: 'source', sessions: { source: { ...source, cli }, target },
    sessionBuffers: { source: 'RAW_PREVIEW' },
  });
  open('copilot');
  const { SendDialog } = loadSource('src/renderer/components/SendDialog.tsx', {
    '../store': { useAppStore, isSendTarget },
  });
  const host = document.createElement('div');
  document.body.append(host);
  const reactRoot = createRoot(host);
  function Harness() {
    return useAppStore(state => state.sendDialogSourceId) ? React.createElement(SendDialog) : null;
  }
  reactRoot.render(React.createElement(Harness));
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, label);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const instruction = async () => {
    await wait(() => host.querySelector('textarea'), 'dialog mounts');
    const textarea = host.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Continue synthetic task');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => [...host.querySelectorAll('button')].some(button =>
      button.textContent.includes('Send') && !button.disabled), 'send enabled');
  };
  const send = () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Send'));
  await instruction();
  assert.ok(host.textContent.includes('Summarize with GitHub Copilot'));
  send().click();
  send().click();
  await wait(() => calls.length === 1, 'one inference despite repeated click');
  assert.equal(writes.length, 0);
  resolveSummary({ summary: null, error: 'Synthetic Copilot unavailable' });
  await wait(() => host.querySelector('[role="alert"]'), 'summary failure visible');
  assert.match(host.querySelector('[role="alert"]').textContent, /Synthetic Copilot unavailable/);
  assert.equal(writes.length, 0, 'failed summarization must not silently broadcast raw text');
  const summaryToggle = () => [...host.querySelectorAll('label')].find(label =>
    label.textContent.includes('Summarize with')).querySelector('input');
  const checkbox = summaryToggle();
  checkbox.click();
  await wait(() => !checkbox.checked && !send().disabled, 'raw send selected explicitly');
  send().click();
  await wait(() => writes.some(write => write.data.startsWith('\x1b[200~')), 'raw paste sent');
  assert.match(writes[0].data, /RAW_PREVIEW/);
  assert.equal(calls.length, 1);
  await wait(() => !host.querySelector('textarea'), 'dialog closes after send');

  open('copilot-resume');
  await instruction();
  const summaryCheckbox = summaryToggle();
  if (!summaryCheckbox.checked) summaryCheckbox.click();
  await wait(() => summaryCheckbox.checked, 'summary restored');
  send().click();
  await wait(() => calls.length === 2, 'Copilot picker summary requested');
  resolveSummary({ summary: 'COPILOT_SUMMARY', error: null });
  await wait(() => writes.filter(write => write.data.startsWith('\x1b[200~')).length === 2, 'summary broadcast');
  const second = writes.filter(write => write.data.startsWith('\x1b[200~'))[1];
  assert.equal(second.id, 'target');
  assert.match(second.data, /COPILOT_SUMMARY/);
  assert.doesNotMatch(second.data, /RAW_PREVIEW/);
  await wait(() => !host.querySelector('textarea'), 'summary send closes dialog');
  open('copilot');
  await instruction();
  send().click();
  await wait(() => calls.length === 3, 'cancelled summary requested');
  useAppStore.getState().closeSendDialog();
  await wait(() => !host.querySelector('textarea'), 'cancelled dialog unmounted');
  resolveSummary({ summary: 'DO_NOT_BROADCAST', error: null });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(writes.filter(write => write.data.startsWith('\x1b[200~')).length, 2, 'cancelled dialog cannot broadcast later');
  open('claude');
  await wait(() => host.textContent.includes('Summarize with Haiku'), 'Claude keeps Haiku label');
  reactRoot.unmount();
  return { realReact: true, copilotAndHaikuLabels: true, duplicateRequestsBlocked: true,
    visibleFailureWithoutBroadcast: true, explicitRawSend: true, copilotSummaryBroadcast: true, lateCancellationSafe: true };
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

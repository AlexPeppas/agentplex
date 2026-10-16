const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { loadSource } = require('./test-support.cjs');
const { claimApplicationInstance } = loadSource('src/main/application-instance.ts');

test('dev and packaged startups use one native ownership namespace and focus only after readiness', async () => {
  const listeners = new Map(), calls = [];
  let ready;
  const appData = path.resolve('synthetic-app-data');
  const app = {
    setName: name => calls.push(['name', name]),
    getPath: () => appData,
    setPath: (name, value) => calls.push([name, value]),
    requestSingleInstanceLock: () => true,
    on: (name, handler) => listeners.set(name, handler),
    whenReady: () => new Promise(resolve => { ready = resolve; }),
    quit: () => assert.fail('owner must not quit'),
  };
  assert.equal(claimApplicationInstance(app, () => calls.push(['focus'])), true);
  assert.deepEqual(calls, [['name', 'AgentPlex'], ['userData', path.join(appData, 'AgentPlex')]]);
  listeners.get('second-instance')();
  assert.equal(calls.length, 2);
  ready();
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ['focus']);
});

test('secondary startup quits without registering ownership callbacks', () => {
  let quit = 0;
  assert.equal(claimApplicationInstance({
    setName() {}, setPath() {}, getPath: () => process.cwd(),
    requestSingleInstanceLock: () => false, quit: () => quit++,
    on: () => assert.fail('secondary must not register owner callbacks'),
  }, () => assert.fail('secondary must not focus itself')), false);
  assert.equal(quit, 1);
});

test('secondary main startup cannot initialize sessions or flush another instance state on quit', async () => {
  const handlers = new Map();
  let quits = 0, starts = 0, stops = 0;
  loadSource('src/main/main.ts', {
    electron: { app: {
      commandLine: { appendSwitch() {} }, setName() {}, setPath() {}, getPath: () => process.cwd(),
      requestSingleInstanceLock: () => false, quit: () => quits++,
      whenReady: async () => {}, on: (name, fn) => handlers.set(name, fn),
    } },
    './session-manager': { sessionManager: { start: () => starts++, stop: () => stops++ } },
    './ipc-handlers': { registerIpcHandlers: () => assert.fail('secondary registered IPC') },
    './shell-detector': {},
    './copilot-summary-proxy': { stopCopilotSummaries: () => assert.fail('secondary blocked quit') },
  });
  await Promise.resolve();
  handlers.get('window-all-closed')();
  handlers.get('before-quit')({ preventDefault: () => assert.fail('secondary prevented quit') });
  assert.equal(quits, 1);
  assert.equal(starts, 0);
  assert.equal(stops, 0);
});

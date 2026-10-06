const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { createRequire } = require('node:module');
const { WebSocket } = require('ws');
const { loadSource } = require('./test-support.cjs');
const { IPC } = loadSource('src/shared/ipc-channels.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('mobile session explorer and creation controls are scoped to a ready machine', () => {
  const webRequire = createRequire(path.resolve(__dirname, '..', 'webclient', 'package.json'));
  const React = webRequire('react');
  const { renderToStaticMarkup } = webRequire('react-dom/server');
  const state = {
    machines: [{ machineId: 'first', name: 'Laptop' }, { machineId: 'second', name: 'Devbox' }],
    sessions: [{ id: 'session-1', machineId: 'first', title: 'Build', cli: 'copilot', cwd: 'C:\\work', status: 'idle' }],
    status: { first: { relayState: 'connected', online: true, ready: true }, second: { relayState: 'connected', online: false, ready: false } },
    displayNames: {},
    capabilities: { first: { home: 'C:\\home', clis: [{ id: 'copilot', label: 'GitHub Copilot' }, { id: 'pwsh', label: 'PowerShell' }] } },
  };
  const store = { useStore: selector => selector(state) };
  const { default: SessionList } = loadSource('webclient/src/components/SessionList.tsx', {
    '../store': store, './CliIcon': { CliIcon: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(SessionList, {
    active: null, onSelectSession() {}, onAddMachine() {}, mobile: true,
  }));
  assert.match(html, /Find sessions/);
  assert.match(html, /New session on Laptop/);
  assert.match(html, /disabled=""[^>]*aria-label="New session on Devbox"/);
  assert.match(html, /Build/);
  const { default: Form } = loadSource('webclient/src/components/NewSessionForm.tsx', { '../store': store });
  const form = renderToStaticMarkup(React.createElement(Form, { machineId: 'first', onDone() {}, onCancel() {} }));
  for (const label of ['C:\\home', 'C:\\work', 'PowerShell', 'GitHub Copilot', 'Directory on this machine']) assert.ok(form.includes(label), label);
});

test('SessionManager publishes local and remote catalog changes without echo loops', async () => {
  const term = { pid: 999, onData() {}, onExit() {}, kill() {}, write() {}, resize() {} };
  const { SessionManager } = loadSource('src/main/session-manager.ts', {
    'node-pty': { spawn: () => term }, electron: {},
    './shell-detector': { getShellById: () => ({ path: 'test-shell' }) },
    './settings-manager': { getDefaultShellId: () => 'test-shell' },
    './claude-session-scanner': {}, './copilot-session-scanner': {},
    './plan-task-detector': { PlanTaskDetector: class {} }, './config-loader': {},
  });
  const manager = new SessionManager();
  manager.saveState = () => {};
  const catalogs = [];
  manager.events.on(IPC.SESSION_CATALOG, event => catalogs.push(event));
  const session = manager.create(process.cwd(), 'test-shell');
  await Promise.resolve();
  assert.equal(catalogs[0].sessions[0].id, session.id);
  manager.updateDisplayName(session.id, 'Renamed remotely');
  await Promise.resolve();
  assert.equal(catalogs[1].names[session.id], 'Renamed remotely');
  manager.updateDisplayName(session.id, 'Renamed remotely');
  await Promise.resolve();
  assert.equal(catalogs.length, 2);
  manager.kill(session.id);
  await Promise.resolve();
  assert.deepEqual(catalogs[2].sessions, []);
});

async function until(predicate, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(25);
  }
}

// Real crypto, relay sockets and browser/store logic; only OS key storage and
// PTYs are replaced. Never connect to or modify the user's running AgentPlex.
function machineFixture(dir, relayUrl) {
  const signKeys = crypto.generateKeyPairSync('ed25519');
  const encKeys = crypto.generateKeyPairSync('x25519');
  const machineId = `machine-${crypto.randomUUID()}`;
  let paired = [];
  const secrets = new Map();
  const proof = (code, ...parts) => crypto.createHmac('sha256', Buffer.from(code.replace(/-/g, ''), 'hex')).update(parts.join('\0')).digest('base64');
  const keys = {
    getMachineId: () => machineId,
    getSigningPublicKeyBase64: () => signKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    getEncryptionPublicKeyBase64: () => encKeys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    getEncryptionKeyPair: () => ({ privateKey: encKeys.privateKey.export({ type: 'pkcs8', format: 'der' }) }),
    sign: data => crypto.sign(null, data, signKeys.privateKey).toString('base64'),
    loadPairedDevices: () => paired,
    savePairedDevices: devices => { paired = devices; },
    addPairedDevice: device => { paired = [...paired.filter(d => d.deviceId !== device.deviceId), device]; },
    removePairedDevice: id => { paired = paired.filter(d => d.deviceId !== id); },
    generatePairingCode: () => crypto.randomBytes(16).toString('hex'),
    hashPairingCode: code => crypto.createHash('sha256').update(code.replace(/-/g, ''), 'hex').digest('hex'),
    createPairingProof: proof,
    verifyPairingProof: (code, actual, ...parts) => proof(code, ...parts) === actual,
    rememberPairingSecret: (hash, secret) => secrets.set(hash, secret),
    getPairingSecret: hash => secrets.get(hash),
    forgetPairingSecret: hash => secrets.delete(hash),
  };
  const sessions = new Map();
  const names = {};
  const buffers = {};
  const writes = [];
  const events = new EventEmitter();
  function catalog() {
    events.emit(IPC.SESSION_CATALOG, { sessions: [...sessions.values()], names: { ...names } });
  }
  const manager = {
    events,
    list: () => [...sessions.values()],
    getDisplayNames: () => ({ ...names }),
    getBuffer: id => buffers[id] ?? '',
    create: (cwd = dir, cli = 'claude') => {
      const id = `session-${sessions.size + 1}`;
      const session = { id, title: id, cwd, cli, pid: 123, status: 'idle', resumeSessionId: null };
      sessions.set(id, session);
      buffers[id] = '';
      names[id] = id;
      catalog();
      return session;
    },
    updateDisplayName: (id, name) => { names[id] = name; catalog(); },
    kill: id => { sessions.delete(id); catalog(); },
    write: (id, data) => {
      writes.push({ id, data });
      buffers[id] += data;
      events.emit(IPC.SESSION_DATA, { id, data });
    },
    resize: (id, cols, rows) => { manager.lastResize = { id, cols, rows }; },
  };
  const desktopCrypto = loadSource('src/main/remote/e2ee.ts', {
    './key-manager': keys, os: { ...os, homedir: () => dir },
  });
  const { RelayClient } = loadSource('src/main/remote/relay-client.ts', {
    './key-manager': keys, './e2ee': desktopCrypto, '../session-manager': { sessionManager: manager },
    '../shell-detector': { getCachedShells: () => [{ id: 'pwsh', label: 'PowerShell' }] },
  });
  manager.create(dir, 'copilot');
  return { client: new RelayClient({ relayUrl }), keys, manager, writes, buffers };
}

function browserFixture() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const encryption = crypto.generateKeyPairSync('x25519');
  const refresh = new Map();
  const keys = {
    getSigningPubKeyB64: async () => signing.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    getEncPubKeyB64: async () => encryption.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    getEncPrivKey: async () => new Uint8Array(encryption.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32)),
    signChallenge: async challenge => crypto.sign(null, Buffer.from(challenge, 'base64'), signing.privateKey).toString('base64'),
    getRefreshToken: async id => refresh.get(id),
    saveRefreshToken: async (id, token) => refresh.set(id, token),
  };
  const webCrypto = loadSource('webclient/src/crypto/e2ee.ts', { './keys': keys });
  const { RelayClient } = loadSource('webclient/src/relay/client.ts', { '../crypto/keys': keys, '../crypto/e2ee': webCrypto });
  return { RelayClient, webCrypto };
}

test('paired multi-machine session control over a real relay: discovery, mutations, terminal, reconnect, revocation', {
  skip: !process.env.RELAY_TEST_BINARY,
  timeout: 60_000,
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-remote-control-'));
  const firstDir = path.join(dir, 'first'), secondDir = path.join(dir, 'second');
  fs.mkdirSync(firstDir); fs.mkdirSync(secondDir);
  const portProbe = net.createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const relayUrl = `http://127.0.0.1:${port}`;
  const relay = spawn(process.env.RELAY_TEST_BINARY, [], {
    env: { ...process.env, LISTEN_ADDR: `127.0.0.1:${port}`, DB_PATH: path.join(dir, 'relay.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let logs = '';
  relay.stderr.on('data', chunk => { logs += chunk; });
  const desktops = [machineFixture(firstDir, relayUrl), machineFixture(secondDir, relayUrl)];
  const storage = new Map();
  const originalSocket = globalThis.WebSocket, originalStorage = globalThis.localStorage;
  globalThis.WebSocket = WebSocket;
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const browser = browserFixture();
  const { useStore } = loadSource('webclient/src/store.ts', { './relay/client': { RelayClient: browser.RelayClient } });
  t.after(async () => {
    useStore.getState().clients.forEach(client => client.stop());
    desktops.forEach(desktop => desktop.client.stop());
    await sleep(150);
    const exited = once(relay, 'exit');
    relay.kill();
    await exited;
    globalThis.WebSocket = originalSocket;
    if (originalStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = originalStorage;
    for (const machineDir of [firstDir, secondDir]) {
      const stateDir = path.join(machineDir, '.agentplex');
      for (const name of ['remote-replay-state.json', 'remote-replay-state.json.tmp']) {
        const file = path.join(stateDir, name);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      if (fs.existsSync(stateDir)) fs.rmdirSync(stateDir);
      fs.rmdirSync(machineDir);
    }
    for (const name of ['relay.db', 'relay.db-shm', 'relay.db-wal']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    fs.rmdirSync(dir);
  });
  await until(() => logs.includes('Listening'), 'relay listening');
  assert.equal((await fetch(`${relayUrl}/health`)).status, 200);
  const paired = [];
  for (const desktop of desktops) {
    await desktop.client.start();
    await until(() => desktop.client.getState() === 'connected', 'desktop relay connected');
    const code = await desktop.client.initiatePairing();
    const machine = await browser.RelayClient.completePairing(relayUrl, desktop.keys.getMachineId(), code, 'test-browser');
    paired.push(machine);
    await until(() => desktop.keys.loadPairedDevices().length === 1, 'local pairing allowlist');
  }
  useStore.setState({ machines: paired });
  await useStore.getState().initRelay();
  await until(() => paired.every(m => useStore.getState().status[m.machineId]?.ready), 'encrypted discovery on both machines');
  assert.doesNotMatch(logs, /SQLITE_BUSY|database is locked/);
  const [first, second] = paired;
  assert.equal(useStore.getState().sessions.length, 2);
  assert.equal(useStore.getState().sessions.filter(s => s.id === 'session-1').length, 2);
  await until(() => useStore.getState().capabilities[first.machineId]?.clis.some(c => c.id === 'pwsh'), 'machine shell capabilities');
  const firstClient = useStore.getState().clients.get(first.machineId);
  const result = await firstClient.request({ type: 'session:create', cwd: firstDir, cli: 'pwsh' });
  assert.equal(result.session.cli, 'pwsh');
  await until(() => useStore.getState().sessions.length === 3, 'new session mirrored');
  await firstClient.request({ type: 'session:rename', id: result.session.id, name: 'Remote build' });
  await until(() => useStore.getState().displayNames[first.machineId]?.[result.session.id] === 'Remote build', 'rename mirrored');
  await assert.rejects(firstClient.request({ type: 'session:create', cwd: path.join(dir, 'missing'), cli: 'copilot' }), /ENOENT/);
  await assert.rejects(firstClient.request({ type: 'session:create', cli: 'not-a-cli' }), /Unsupported CLI/);
  assert.equal(desktops[0].manager.list().length, 2);
  await Promise.all(['one', 'two', 'three'].map(data => firstClient.send({ type: 'session:write', id: 'session-1', data })));
  await until(() => desktops[0].writes.length === 3, 'ordered terminal input');
  assert.deepEqual(desktops[0].writes.map(w => w.data), ['one', 'two', 'three']);
  assert.equal(desktops[1].writes.length, 0);
  desktops[0].buffers['session-1'] = 'x'.repeat(512 * 1024);
  useStore.getState().setActiveSession(first.machineId, 'session-1');
  await until(() => useStore.getState().terminalData[`${first.machineId}:session-1`]?.length === 512 * 1024, 'large encrypted scrollback');
  await firstClient.send({ type: 'session:resize', id: 'session-1', cols: 99, rows: 33 });
  await until(() => desktops[0].manager.lastResize?.cols === 99, 'PTY resize');
  desktops[0].manager.events.emit(IPC.SESSION_STATUS, { id: 'session-1', status: 'running' });
  await until(() => useStore.getState().sessions.find(s => s.machineId === first.machineId && s.id === 'session-1')?.status === 'running', 'status mirrored');

  // A browser socket loss must disable input and refresh the buffer on reconnect.
  firstClient.ws.close();
  await until(() => !useStore.getState().status[first.machineId].ready, 'browser offline state');
  await assert.rejects(firstClient.send({ type: 'session:write', id: 'session-1', data: 'must-not-replay' }), /disconnected|offline|changed/);
  desktops[0].buffers['session-1'] = 'fresh after reconnect';
  await until(() => useStore.getState().status[first.machineId].ready, 'browser automatic reconnect');
  await until(() => useStore.getState().terminalData[`${first.machineId}:session-1`] === 'fresh after reconnect', 'reconnected buffer replacement');
  assert.equal(desktops[0].writes.length, 3);
  // Machine socket loss must also reconnect, without reconnecting the browser.
  desktops[0].client.ws.close();
  await until(() => !useStore.getState().status[first.machineId].ready, 'machine offline state');
  await until(() => useStore.getState().status[first.machineId].ready, 'machine automatic reconnect');

  // Local creation/removal must reach every paired view, not just requesters.
  desktops[1].manager.create(secondDir, 'copilot');
  await until(() => useStore.getState().sessions.filter(s => s.machineId === second.machineId).length === 2, 'local creation mirrored');
  await firstClient.request({ type: 'session:kill', id: result.session.id });
  await until(() => !useStore.getState().sessions.some(s => s.machineId === first.machineId && s.id === result.session.id), 'stop/removal mirrored');

  // Relay authorization alone is insufficient without the machine allowlist.
  const count = desktops[0].writes.length;
  const device = desktops[0].keys.loadPairedDevices()[0];
  desktops[0].keys.removePairedDevice(device.deviceId);
  await firstClient.send({ type: 'session:write', id: 'session-1', data: 'unauthorized' });
  await sleep(100);
  assert.equal(desktops[0].writes.length, count);
  desktops[0].keys.addPairedDevice(device);
  await desktops[0].client.revokeDevice(first.deviceId);
  await until(() => !useStore.getState().status[first.machineId].ready, 'revoked browser disconnected');
  assert.equal(desktops[0].keys.loadPairedDevices().length, 0);
  assert.equal(useStore.getState().status[second.machineId].ready, true);
});

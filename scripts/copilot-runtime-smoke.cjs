const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { app } = require('electron');

app.setPath('userData', process.env.AGENTPLEX_EDITOR_E2E_ROOT);

app.whenReady().then(async () => {
  const archive = path.resolve(__dirname, '..', 'out', `AgentPlex-${process.platform}-${process.arch}`, 'resources', 'app.asar');
  const modules = path.join(archive, 'node_modules');
  const { CopilotClient, RuntimeConnection } = await import(
    pathToFileURL(path.join(modules, '@github', 'copilot-sdk', 'dist', 'index.js')).href);
  const missing = path.join(process.env.AGENTPLEX_EDITOR_E2E_ROOT, 'nonexistent-copilot.exe');
  const client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: missing }),
    baseDirectory: process.env.AGENTPLEX_EDITOR_E2E_ROOT,
    workingDirectory: process.env.AGENTPLEX_EDITOR_E2E_ROOT,
  });
  try {
    await assert.rejects(client.start(), /ENOENT|not found|does not exist/i);
  } finally {
    await client.forceStop();
  }
  const unpacked = archive + '.unpacked';
  const runtimeRoot = path.join(unpacked, 'node_modules', '@github', `copilot-sdk-${process.platform}-${process.arch}`);
  const runtime = path.join(runtimeRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'runtime.node');
  assert.ok(fs.statSync(runtime).size > 0, 'SDK runtime must be a physical unpacked file');
  const koffi = require(path.join(modules, 'koffi'));
  const library = koffi.load(runtime);
  assert.equal(typeof library.func('copilot_runtime_host_shutdown', 'bool', ['uint32']), 'function');
  library.unload();
  const installed = [
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'copilot.exe' : 'copilot'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'GitHub CLI', 'copilot', 'copilot.exe')] : []),
    ...(process.env.PATH ?? '').split(path.delimiter).map(directory =>
      path.join(directory, process.platform === 'win32' ? 'copilot.exe' : 'copilot')),
  ].find(candidate => fs.existsSync(candidate));
  assert.ok(installed, 'full Copilot CLI must be installed for the stdio handshake');
  const command = fs.realpathSync(installed);
  const offline = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: command,
      args: ['--disable-builtin-mcps', '--no-custom-instructions', '--no-remote', '--no-remote-export', '--no-auto-update'],
    }),
    baseDirectory: process.env.AGENTPLEX_EDITOR_E2E_ROOT,
    workingDirectory: process.env.AGENTPLEX_EDITOR_E2E_ROOT,
    gitHubToken: 'synthetic-offline-token',
    useLoggedInUser: false,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, COPILOT_ALLOW_ALL: 'false',
      ...(command.endsWith('.js') ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    },
  });
  let timer;
  try {
    await Promise.race([
      offline.start(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Runtime handshake timed out')), 30000); }),
    ]);
    assert.equal(typeof (await offline.ping('Synthetic offline handshake')).protocolVersion, 'number');
    assert.deepEqual(await offline.listSessions(), [], 'isolated runtime cannot see production sessions');
  } finally {
    clearTimeout(timer);
    await offline.forceStop();
  }
  console.log(JSON.stringify({ packagedSdk: true, realStdioHandshake: true, isolatedEmptyHistory: true, unpackedNativeRuntime: true, nativeFfiLoad: true, inferenceCalls: 0 }));
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});

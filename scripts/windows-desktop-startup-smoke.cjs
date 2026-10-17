const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  if (process.platform !== 'win32') throw new Error('This packaged Windows startup smoke requires Windows');
  const executable = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out', 'AgentPlex-win32-x64', 'AgentPlex.exe'));
  await fs.access(executable);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentplex-startup-'));
  const children = [];
  let output = '';
  let phase = 'primary startup';
  const stateFile = path.join(root, '.agentplex', 'state.json');
  const sentinel = { displayName: 'Owned restore record', cwd: path.join(root, 'unavailable-workspace'),
    cli: 'copilot', resumeSessionId: '11111111-1111-4111-8111-111111111111' };
  const env = { ...process.env, HOME: root, USERPROFILE: root,
    APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    TEMP: path.join(root, 'AppData', 'Local', 'Temp'), TMP: path.join(root, 'AppData', 'Local', 'Temp'),
    ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = (binary = executable, args = [], environment = env) => {
    const child = spawn(binary, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => resolve(code));
    });
    const owned = { child, exited };
    children.push(owned);
    return owned;
  };
  const inspect = async pid => {
    const command = `$p = Get-Process -Id ${pid} -ErrorAction Stop; $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.OwningProcess -eq ${pid} } | Select-Object LocalAddress,LocalPort); [pscustomobject]@{ window = ($p.MainWindowHandle -ne 0); title = $p.MainWindowTitle; responding = $p.Responding; listeners = $listeners } | ConvertTo-Json -Depth 3 -Compress`;
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 });
    return JSON.parse(stdout.trim());
  };
  const waitForExit = async owned => {
    let timeout;
    try {
      return await Promise.race([owned.exited, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Owned process ${owned.child.pid} did not exit`)), 15000);
      })]);
    } finally { clearTimeout(timeout); }
  };
  try {
    await Promise.all([fs.mkdir(path.dirname(stateFile), { recursive: true }),
      fs.mkdir(env.APPDATA, { recursive: true }), fs.mkdir(env.TEMP, { recursive: true })]);
    await fs.writeFile(stateFile, JSON.stringify({ sessions: { sentinel } }));
    const primary = launch();
    let status;
    const deadline = Date.now() + 30000;
    do {
      assert.equal(primary.child.exitCode, null, output);
      status = await inspect(primary.child.pid);
      if (status.window && status.responding) break;
      await delay(200);
    } while (Date.now() < deadline);
    assert.ok(status.window && status.responding, `packaged window did not become ready:\n${output}`);
    assert.match(status.title, /AgentPlex/, `unexpected startup window:\n${output}`);
    await delay(2000);
    phase = 'second packaged launch';
    const secondary = launch();
    assert.equal(await waitForExit(secondary), 0, output);
    phase = 'parallel dev launch';
    const dev = launch(require('electron'), [path.join(__dirname, 'desktop-priorities-e2e.cjs'), '--ownership-secondary'],
      { ...env, AGENTPLEX_EDITOR_E2E_ROOT: env.APPDATA });
    assert.equal(await waitForExit(dev), 0, 'dev and packaged entrypoints must share the same owner');
    status = await inspect(primary.child.pid);
    assert.ok(status.window && status.responding, 'primary remains responsive after second launch');
    assert.deepEqual(status.listeners, [], 'normal startup must not expose a browser debugging TCP listener');
    assert.doesNotMatch(output, /DevTools listening|Renderer process gone|UNCAUGHT EXCEPTION|UNHANDLED REJECTION/);
    phase = 'primary graceful shutdown';
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${primary.child.pid} -ErrorAction Stop).CloseMainWindow()`], { timeout: 15000 });
    assert.match(stdout, /True/);
    assert.equal(await waitForExit(primary), 0, output);
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    assert.deepEqual(Object.values(saved.sessions), [sentinel],
      'both startup and secondary shutdown must preserve the unavailable restore record');
    console.log(JSON.stringify({ packagedWindowResponsive: true, secondPackagedLaunchRejected: true, parallelDevLaunchRejected: true,
      restoreRecordPreserved: true, tcpListeners: status.listeners, remoteDevToolsDisabled: true }));
  } catch (error) {
    throw new Error(`${phase}: ${error.message}\n${output}`, { cause: error });
  } finally {
    for (const owned of children) {
      if (owned.child.exitCode === null) owned.child.kill();
      await owned.exited;
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadSource } = require('./test-support.cjs');

test('startup and simultaneous IPC requests share one shell probe without loading PowerShell profiles', async () => {
  const calls = [];
  const { detectShells, getCachedShells, getShellById } = loadSource('src/main/shell-detector.ts', {
    fs: { statSync: () => ({ isFile: () => true }) },
    child_process: {
      execFile(command, args, options, callback) {
        calls.push({ command, args, options });
        const stdout = command === 'which' ? '/fixture/pwsh'
          : args.includes('--version') ? 'PowerShell 7.5.1' : '5.1.26100.7462';
        queueMicrotask(() => callback(null, stdout));
      },
    },
  });
  const [first, second, third] = await Promise.all([detectShells(), detectShells(), detectShells()]);
  assert.equal(first, second, 'concurrent requests must resolve to the same detected shells');
  assert.equal(second, third);
  assert.equal(calls.filter(call => call.args.includes('--version')).length, 1, 'only one version process is needed');
  if (process.platform === 'win32') {
    const windows = calls.filter(call => call.args.includes('-Command'));
    assert.equal(windows.length, 1);
    assert.ok(windows[0].args.includes('-NoProfile'));
    assert.ok(windows[0].args.includes('-NonInteractive'));
  }
  const count = calls.length;
  assert.equal(await detectShells(), first);
  assert.equal(calls.length, count, 'completed detection stays cached');
  assert.equal(getCachedShells(), first);
  assert.equal(getShellById('pwsh'), first.find(shell => shell.id === 'pwsh'));
});

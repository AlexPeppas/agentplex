const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentplex-editor-e2e-'));
  try {
    const electron = require('electron');
    const child = spawn(electron, [path.join(__dirname, 'git-editor-e2e.cjs')], {
      env: { ...process.env, AGENTPLEX_EDITOR_E2E_ROOT: root },
      stdio: 'inherit',
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => {
        if (signal) reject(new Error(`Electron test terminated: ${signal}`));
        else resolve(status ?? 1);
      });
    });
    process.exitCode = code;
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

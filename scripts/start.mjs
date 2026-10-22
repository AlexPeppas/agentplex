import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStartupBuild } from './startup-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

try {
  process.env.NODE_ENV = 'production';
  await import('./check-startup-dependencies.mjs');
  if (!process.exitCode) {
    await ensureStartupBuild(root);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    child.once('error', error => {
      console.error('[startup] Cannot launch Electron:', error);
      process.exitCode = 1;
    });
    child.once('exit', (code, signal) => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
} catch (error) {
  console.error('[startup] Failed to prepare application:', error);
  process.exitCode = 1;
}

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let missing = false;
for (const name of Object.keys(manifest.dependencies ?? {})) {
  try {
    const entry = fileURLToPath(import.meta.resolve(name));
    if (!statSync(entry).isFile()) throw new Error('Package entry is not a file');
  } catch (error) {
    missing = true;
    console.error(`[startup] Cannot resolve ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (missing) {
  console.error('\n[startup] Dependencies are missing or incomplete. After pulling changes, run:\n\n  pnpm install --frozen-lockfile\n  pnpm start\n');
  process.exitCode = 1;
}

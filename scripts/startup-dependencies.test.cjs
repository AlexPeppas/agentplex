const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentplex-startup-deps-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const script = path.join(root, 'scripts', 'check-startup-dependencies.mjs');
  fs.copyFileSync(path.join(__dirname, 'check-startup-dependencies.mjs'), script);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    install(name, entry = true) {
      const directory = path.join(root, 'node_modules', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({
        name, version: '1.0.0', exports: { '.': { import: './index.mjs' } },
      }));
      if (entry) fs.writeFileSync(path.join(directory, 'index.mjs'), 'throw new Error("Dependency checks must not execute package code");');
    },
    run: () => spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 5000 }),
  };
}

test('startup resolves installed ESM packages without executing them or requiring unrelated dev tools', t => {
  const f = fixture(t, { dependencies: { '@fixture/runtime': '1.0.0' }, devDependencies: { '@types/example': '1.0.0' } });
  f.install('@fixture/runtime');
  const result = f.run();
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('startup reports missing runtime packages and incomplete entries with a recovery command', t => {
  const f = fixture(t, { dependencies: { missing: '1.0.0', incomplete: '1.0.0' } });
  f.install('incomplete', false);
  const result = f.run();
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  for (const name of ['missing', 'incomplete']) assert.match(result.stderr, new RegExp(`Cannot resolve ${name}:`));
  assert.match(result.stderr, /pnpm install --frozen-lockfile/);
  assert.match(result.stderr, /pnpm start/);
});

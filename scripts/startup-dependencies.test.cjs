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
    root,
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

async function cacheFixture(t) {
  const { ensureStartupBuild } = await import('./startup-cache.mjs');
  const { root } = fixture(t, {});
  for (const name of ['src', 'styles', 'assets']) fs.mkdirSync(path.join(root, name));
  for (const name of ['pnpm-lock.yaml', 'forge.config.ts', 'tsconfig.json', 'index.html',
    'vite.main.config.mts', 'src/main.ts', 'styles/index.css', 'assets/icon.png', 'scripts/start.mjs', 'scripts/startup-cache.mjs']) {
    fs.writeFileSync(path.join(root, name), 'first');
  }
  let builds = 0;
  const build = async () => {
    builds++;
    for (const name of ['build/main.js', 'build/preload.js', 'build/office-preview-worker.js', 'renderer/main_window/index.html']) {
      const filename = path.join(root, '.vite', name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, `build ${builds}`);
    }
  };
  return { root, build, prepare: () => ensureStartupBuild(root, build), ensureStartupBuild, builds: () => builds };
}

test('startup reuses a valid build but invalidates source, config, assets, environment files and lockfile changes', async t => {
  const f = await cacheFixture(t);
  assert.equal(await f.prepare(), true);
  assert.equal(await f.prepare(), false);
  assert.equal(f.builds(), 1);
  for (const name of ['src/main.ts', 'vite.main.config.mts', 'assets/icon.png', 'pnpm-lock.yaml']) {
    const filename = path.join(f.root, name);
    const before = fs.statSync(filename);
    fs.writeFileSync(filename, 'other');
    fs.utimesSync(filename, before.atime, before.mtime);
    assert.equal(await f.prepare(), true, `${name} must invalidate even when size and modification time are preserved`);
    assert.equal(await f.prepare(), false);
  }
  fs.writeFileSync(path.join(f.root, '.env.production'), 'VITE_TEST=changed');
  assert.equal(await f.prepare(), true);
});

test('missing and modified production outputs cannot be reused as a current build', async t => {
  const f = await cacheFixture(t);
  await f.prepare();
  const preload = path.join(f.root, '.vite', 'build', 'preload.js');
  fs.unlinkSync(preload);
  assert.equal(await f.prepare(), true);
  const before = fs.statSync(preload);
  fs.writeFileSync(preload, 'x'.repeat(before.size));
  fs.utimesSync(preload, before.atime, before.mtime);
  assert.equal(await f.prepare(), true);
  assert.equal(await f.prepare(), false);
});

test('failed or incomplete startup builds remain failures and release the build lock for recovery', async t => {
  const f = await cacheFixture(t);
  await assert.rejects(f.ensureStartupBuild(f.root, async () => { throw new Error('synthetic build failure'); }),
    /synthetic build failure/);
  assert.equal(fs.existsSync(path.join(f.root, '.vite', 'startup-cache.json')), false);
  await assert.rejects(f.ensureStartupBuild(f.root, async () => {}), /all required application files/);
  await assert.rejects(f.ensureStartupBuild(f.root, async () => {
    await f.build();
    fs.appendFileSync(path.join(f.root, 'src', 'main.ts'), 'changed during build');
  }), /Source changed during the startup build/);
  assert.equal(await f.prepare(), true);
  assert.equal(await f.prepare(), false);
});

test('concurrent startup commands share one complete build instead of overwriting each other', async t => {
  const f = await cacheFixture(t);
  const build = async () => { await new Promise(resolve => setTimeout(resolve, 80)); await f.build(); };
  const results = await Promise.all([f.ensureStartupBuild(f.root, build), f.ensureStartupBuild(f.root, build)]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(f.builds(), 1);
});

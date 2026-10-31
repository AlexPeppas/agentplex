import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

async function filesIn(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(filename) : [filename];
  }));
  return files.flat();
}

export async function startupFingerprint(root) {
  const names = await fs.readdir(root);
  const files = [
    ...(await Promise.all(['src', 'styles', 'assets', ...(names.includes('public') ? ['public'] : [])]
      .map(name => filesIn(path.join(root, name))))).flat(),
    ...names.filter(name => /^(?:vite\..*config\.|(?:postcss|tailwind)\.config\.|\.env(?:\.|$))/.test(name))
      .map(name => path.join(root, name)),
    ...['package.json', 'pnpm-lock.yaml', 'forge.config.ts', 'tsconfig.json', 'index.html',
      'scripts/start.mjs', 'scripts/startup-cache.mjs', 'scripts/check-startup-dependencies.mjs']
      .map(name => path.join(root, name)),
  ].sort();
  const hash = createHash('sha256').update(JSON.stringify({
    version: 2, node: process.version, platform: process.platform, arch: process.arch,
    environment: Object.entries(process.env).filter(([name]) =>
      (name.startsWith('VITE_') && !['VITE_CJS_IGNORE_WARNING', 'VITE_CONFIG_NATIVE_IGNORE_WARNING'].includes(name)) ||
      name === 'NODE_ENV').sort(),
  }));
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = files.slice(offset, offset + 16);
    const contents = await Promise.all(batch.map(filename => fs.readFile(filename)));
    batch.forEach((filename, index) => {
      hash.update(path.relative(root, filename)).update('\0').update(contents[index]).update('\0');
    });
  }
  return hash.digest('hex');
}

async function outputSnapshot(root) {
  const directories = [path.join(root, '.vite', 'build'), path.join(root, '.vite', 'renderer')];
  try {
    const files = (await Promise.all(directories.map(filesIn))).flat().sort();
    for (const required of ['build/main.js', 'build/preload.js', 'build/office-preview-worker.js', 'renderer/main_window/index.html']) {
      await fs.access(path.join(root, '.vite', required));
    }
    return await Promise.all(files.map(async filename => {
      const digest = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
      return [path.relative(root, filename), digest];
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function cacheIsCurrent(root, fingerprint) {
  let cache;
  try {
    cache = JSON.parse(await fs.readFile(path.join(root, '.vite', 'startup-cache.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    if (!(error instanceof SyntaxError)) throw error;
    console.warn('[startup] Invalid build cache; rebuilding');
    return false;
  }
  return cache.fingerprint === fingerprint && JSON.stringify(cache.outputs) === JSON.stringify(await outputSnapshot(root));
}

async function acquireBuildLock(root) {
  const lock = path.join(root, '.vite', 'startup.lock');
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const began = performance.now();
  while (true) {
    try {
      const handle = await fs.open(lock, 'wx');
      try { await handle.writeFile(String(process.pid)); }
      catch (error) { await handle.close(); await fs.unlink(lock); throw error; }
      return async () => { await handle.close(); await fs.unlink(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(await fs.readFile(lock, 'utf8'));
        if (pid) {
          try { process.kill(pid, 0); }
          catch (error) {
            if (error.code !== 'ESRCH') {
              if (error.code !== 'EPERM') throw error;
            } else {
              await fs.unlink(lock);
              continue;
            }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (performance.now() - began > 120000) throw new Error(`Timed out waiting for startup build lock: ${lock}`);
      await delay(50);
    }
  }
}

export async function buildStartupApp(root) {
  const { build, loadConfigFromFile, mergeConfig } = await import('vite');
  const environment = { command: 'build', mode: 'production', root };
  const forge = await loadConfigFromFile(environment, path.join(root, 'forge.config.ts'), root, 'warn');
  const targets = forge.config.plugins.find(plugin => plugin.name === 'vite')?.config;
  if (!targets?.build || !targets?.renderer) throw new Error('Missing Forge Vite build targets');
  const external = ['electron', 'electron/main', 'electron/renderer',
    ...builtinModules.flatMap(name => [name, `node:${name}`])];
  const define = Object.fromEntries(targets.renderer.flatMap(({ name }) => {
    const prefix = name.toUpperCase().replaceAll('-', '_');
    return [[`${prefix}_VITE_DEV_SERVER_URL`, 'undefined'], [`${prefix}_VITE_NAME`, JSON.stringify(name)]];
  }));
  await fs.rm(path.join(root, '.vite', 'build'), { recursive: true, force: true });
  await Promise.all([
    ...targets.build.map(async target => {
      const user = await loadConfigFromFile({ ...environment, forgeConfig: targets, forgeConfigSelf: target },
        path.resolve(root, target.config), root, 'warn');
      const preload = target.target === 'preload';
      await build(mergeConfig({
        root, configFile: false, mode: 'production', logLevel: 'warn', clearScreen: false, define,
        resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
        build: {
          outDir: '.vite/build', emptyOutDir: false, copyPublicDir: false, minify: true,
          ...(preload ? {} : { lib: { entry: target.entry, fileName: () => '[name].js', formats: ['cjs'] } }),
          rollupOptions: { external, ...(preload ? { input: target.entry,
            output: { format: 'cjs', inlineDynamicImports: true, entryFileNames: '[name].js',
              chunkFileNames: '[name].js', assetFileNames: '[name].[ext]' } } : {}) },
        },
      }, user.config));
    }),
    ...targets.renderer.map(async target => {
      const user = await loadConfigFromFile({ ...environment, forgeConfig: targets, forgeConfigSelf: target },
        path.resolve(root, target.config), root, 'warn');
      await build(mergeConfig({
        root, configFile: false, mode: 'production', base: './', logLevel: 'warn', clearScreen: false,
        build: { outDir: `.vite/renderer/${target.name}`, emptyOutDir: true, minify: true },
      }, user.config));
    }),
  ]);
}

export async function ensureStartupBuild(root, build = buildStartupApp) {
  const release = await acquireBuildLock(root);
  try {
    const fingerprint = await startupFingerprint(root);
    if (await cacheIsCurrent(root, fingerprint)) return false;
    await fs.rm(path.join(root, '.vite', 'startup-cache.json'), { force: true });
    console.log('[startup] Building updated application (subsequent unchanged launches reuse this build)...');
    await build(root);
    if (await startupFingerprint(root) !== fingerprint) {
      throw new Error('Source changed during the startup build; retry pnpm start or use pnpm dev');
    }
    const outputs = await outputSnapshot(root);
    if (!outputs) throw new Error('Startup build did not produce all required application files');
    const filename = path.join(root, '.vite', 'startup-cache.json');
    const temporary = `${filename}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ fingerprint, outputs }));
    await fs.rename(temporary, filename);
    return true;
  } finally { await release(); }
}

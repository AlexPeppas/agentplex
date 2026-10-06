import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    icon: 'assets/logo',
    extraResource: ['assets/logo.png', 'assets/logo.ico', 'assets/logo.icns'],
  },
  rebuildConfig: {
    // Skip native rebuild — node-pty ships N-API prebuilds that work across Node/Electron
    onlyModules: ['__none__'],
  },
  hooks: {
    packageAfterCopy: async (_config, buildPath) => {
      // External runtimes must include their required dependencies, including under pnpm.
      const path = await import('path');
      const fs = await import('fs/promises');
      const { createRequire } = await import('node:module');
      const copy = async (pkg: string, from: string, destination: string, ancestors: Set<string>) => {
        const resolve = createRequire(path.join(from, 'package.json')).resolve;
        let source = path.dirname(resolve(pkg));
        let manifest: { name?: string; dependencies?: Record<string, string> };
        for (;;) {
          try { manifest = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            manifest = {};
          }
          if (manifest.name === pkg) break;
          const parent = path.dirname(source);
          if (parent === source) throw new Error(`Cannot find package manifest for ${pkg}`);
          source = parent;
        }
        if (ancestors.has(source)) return;
        const dest = path.join(destination, 'node_modules', pkg);
        await fs.cp(source, dest, { recursive: true, dereference: true,
          filter: file => path.basename(file) !== 'node_modules' });
        const chain = new Set([...ancestors, source]);
        // Optional SDK native runtimes are intentionally omitted: Plex uses the installed CLI.
        for (const dependency of Object.keys(manifest.dependencies ?? {})) await copy(dependency, source, dest, chain);
      };
      for (const pkg of ['node-pty', 'ws', 'amqplib', '@github/copilot-sdk']) {
        await copy(pkg, process.cwd(), buildPath, new Set());
      }
    },
  },
  makers: [
    new MakerSquirrel({ setupExe: 'AgentPlex.exe', setupIcon: 'assets/logo.ico', loadingGif: 'assets/installer.gif', iconUrl: 'https://raw.githubusercontent.com/AlexPeppas/agentplex/master/assets/logo.ico' }),
    new MakerZIP({}, ['darwin']),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.mts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.mts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
  ],
};

export default config;

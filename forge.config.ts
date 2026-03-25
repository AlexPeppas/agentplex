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
      // node-pty is marked external by Vite, so it's not in the bundle.
      // Copy it (with prebuilds) into the packaged app's node_modules.
      const path = await import('path');
      const fs = await import('fs-extra');
      const src = path.join(process.cwd(), 'node_modules', 'node-pty');
      const dest = path.join(buildPath, 'node_modules', 'node-pty');
      if (await fs.pathExists(src)) {
        await fs.copy(src, dest);
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

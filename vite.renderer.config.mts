import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export default defineConfig({
  build: {
    target: 'chrome134',
  },
  plugins: [react(), tailwindcss(), {
    name: 'bundled-pdf-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', async (request, response, next) => {
        const match = request.url?.split('?')[0].match(/^\/(cmaps|standard_fonts|wasm)\/([\w.-]+)$/);
        if (!match) { next(); return; }
        try {
          const bytes = await readFile(path.resolve('node_modules', 'pdfjs-dist', match[1], match[2]));
          response.setHeader('Content-Type', match[2].endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
          response.end(bytes);
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        const root = path.resolve('node_modules', 'pdfjs-dist', directory);
        for (const name of await readdir(root)) {
          this.emitFile({ type: 'asset', fileName: `pdfjs/${directory}/${name}`, source: await readFile(path.join(root, name)) });
        }
      }
    },
  }],
});

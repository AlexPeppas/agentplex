import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  build: {
    target: 'chrome134',
  },
  server: {
    watch: {
      // Strictly watch only renderer UI source, styles, and index.html.
      // Ignore all workspace files, session directories, and backend code so that
      // editing/saving files in the in-app file explorer never causes dev server reloads.
      ignored: (filePath: string) => {
        const norm = filePath.replace(/\\/g, '/');
        const root = process.cwd().replace(/\\/g, '/');

        if (norm.endsWith('/index.html') || norm.endsWith('index.html')) {
          return false;
        }

        if (
          norm.includes('/src/renderer/') ||
          norm.endsWith('/src/renderer') ||
          norm.includes('/styles/') ||
          norm.endsWith('/styles')
        ) {
          return false;
        }

        if (norm === root || norm.endsWith('/src') || norm === '.' || norm === '') {
          return false;
        }

        return true;
      },
    },
  },
  plugins: [react(), tailwindcss()],
});


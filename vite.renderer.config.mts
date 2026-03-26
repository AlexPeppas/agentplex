import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  build: {
    target: 'chrome134',
  },
  plugins: [react()],
});

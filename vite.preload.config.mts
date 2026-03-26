import { defineConfig, type Plugin } from 'vite';

// Forge's preload config sets the deprecated inlineDynamicImports.
// Replace it with Vite 8's codeSplitting: false.
const fixDeprecatedInlineDynamicImports: Plugin = {
  name: 'fix-inline-dynamic-imports',
  config(config) {
    const output = config.build?.rollupOptions?.output;
    if (output && !Array.isArray(output) && output.inlineDynamicImports) {
      delete output.inlineDynamicImports;
      config.build ??= {};
      (config.build as Record<string, unknown>).codeSplitting = false;
    }
  },
};

export default defineConfig({
  build: {
    target: 'node22',
  },
  plugins: [fixDeprecatedInlineDynamicImports],
});

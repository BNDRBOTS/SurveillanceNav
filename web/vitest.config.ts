import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Kept separate from vite.config.ts: vitest bundles its own vite, and mixing
// plugin types across the two trips strict typechecking. esbuild handles the
// JSX transform in tests; @vitejs/plugin-react is only needed for dev HMR.
export default defineConfig({
  resolve: {
    alias: {
      '@stn/shared': path.resolve(__dirname, '../shared/src/index.ts'),
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    css: false,
  },
});

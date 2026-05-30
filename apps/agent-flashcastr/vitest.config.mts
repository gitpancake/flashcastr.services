import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/agent-flashcastr',
  test: {
    name: '@life-os/agent-flashcastr',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
  },
  resolve: {
    alias: {
      '@life-os/shared': resolve(__dirname, '../../libs/shared/src/index.ts'),
    },
  },
}));

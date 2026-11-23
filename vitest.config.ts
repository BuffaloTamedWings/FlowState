import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(import.meta.dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'shared'),
      '@engine': resolve(repoRoot, 'engine/src'),
      '@web': resolve(repoRoot, 'web/src'),
    },
  },
  test: {
    environment: 'node',
    include: ['web/test/**/*.test.ts', 'engine/test/**/*.test.ts', 'shared/**/*.test.ts'],
  },
});

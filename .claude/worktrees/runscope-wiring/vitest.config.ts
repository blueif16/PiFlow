import { defineConfig } from 'vitest/config';

// Single root config for the workspace. Globals are off (explicit imports from 'vitest').
// One package today (`@piflow/core`); add more via the `packages/*/test` glob automatically.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    watch: false,
  },
});

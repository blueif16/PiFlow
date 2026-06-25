import { defineConfig } from 'vitest/config';

// Single root config for the workspace. Globals are off (explicit imports from 'vitest').
// Packages under `packages/*`; the `tui` monitor lives top-level (beside `gui`), so it has its own glob.
export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.mjs',
      'tui/test/**/*.test.mjs',
    ],
    environment: 'node',
    watch: false,
  },
});

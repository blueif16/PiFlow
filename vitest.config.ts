import { defineConfig } from 'vitest/config';

// Single root config for the workspace. Globals are off (explicit imports from 'vitest').
// Packages under `packages/*`; the `tui` monitor lives top-level (beside `gui`), so it has its own glob.
export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.mjs',
      'tui/test/**/*.test.mjs',
      // gui pure-lib tests (the control-session framing contract) — written as real vitest, unlike the
      // older node-runnable gui/src checks, so they ride the repo `npm test` gate.
      'gui/scripts/lib/**/*.test.mjs',
      // gui view-model reducers (controlSession fold) — pure TS, no DOM, run under the node env.
      'gui/src/**/*.test.ts',
    ],
    environment: 'node',
    watch: false,
  },
});

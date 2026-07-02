import { defineConfig, configDefaults } from 'vitest/config';

// Workspace test config, split into two PROJECTS so CI has a deterministic, green-by-default gate:
//   • `default` — pure/unit/integration; no credentials, no live services, no heavy runtime. Runs on every PR.
//   • `live`    — opt-in e2e needing real credentials, a cloud VM, a configured `pi`, or the heavy openclaw
//                 runtime. Run with PIFLOW_LIVE / PIFLOW_E2E + keys set (see the package.json `test:*` scripts).
// Globals are off (explicit imports from 'vitest').
//
// Files binned to `live` are EXCLUDED from the default gate but still run under `--project live` — they are
// binned, not lobotomized; no assertion is deleted or weakened. Rationale per file:
//   - sandbox-daytona-e2e            : boots a real Daytona VM (needs DAYTONA_API_KEY + PIFLOW_E2E).
//   - tool-bridge-openclaw-gateway.e2e: spawns the heavy (~86 MB) openclaw plugin-tools-serve runtime.
//   - spike-full-plugin-loop         : openclaw plugin-cache SPIKE; the copied cache can't resolve openclaw's
//                                      transitive deps (e.g. typebox) under pnpm's non-flat layout —
//                                      environment-sensitive, not a unit of piflow's own logic.
// (Other live cases — daytona/e2b parity, runner-live, the gated-live `pi` cases — already self-skip via env
//  probes + PIFLOW_LIVE and so stay safely in `default`, where their deterministic siblings carry coverage.)
const LIVE = [
  'packages/daytona/test/sandbox-daytona-e2e.test.ts',
  'packages/tool-bridge/test/tool-bridge-openclaw-gateway.e2e.test.ts',
  'packages/core/test/spike-full-plugin-loop.test.ts',
  // L3 control-plane full-run: greet in a REAL e2b VM + real model writes CONTROL-VM-OK (self-skips w/o creds).
  // The vitest-native twin of deploy/control-vm/smoke-live.mjs's D-check — closes "L3 exercises nothing new".
  'packages/e2b/test/control-plane-full-run.live.test.ts',
];

const include = [
  'packages/*/test/**/*.test.ts',
  'packages/*/test/**/*.test.mjs',
  'tui/test/**/*.test.mjs',
  // gui pure-lib tests (control-session framing contract) — real vitest, ride the repo test gate.
  'gui/scripts/lib/**/*.test.mjs',
  // gui view-model reducers (controlSession fold) — pure TS, no DOM, node env.
  'gui/src/**/*.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'default',
          include,
          exclude: [...configDefaults.exclude, ...LIVE],
          environment: 'node',
          watch: false,
          // ink-testing-library full-App renders cost ~1-2s each under the parallel fork pool; this ceiling
          // absorbs slow-but-correct TUI renders without masking real hangs (unit tests finish in ms).
          testTimeout: 20000,
        },
      },
      {
        test: {
          name: 'live',
          include: LIVE,
          environment: 'node',
          watch: false,
          testTimeout: 180000, // real model/VM round-trips
        },
      },
    ],
  },
});

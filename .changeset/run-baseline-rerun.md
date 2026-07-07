---
"@piflow/core": minor
"@piflow/cli": minor
---

`piflowctl run --baseline <id|path> [--stage-only]` — seed a NEW run from a BASELINE run so a windowed
`--from` re-run executes ONLY the node(s) under test on FROZEN upstream (every upstream node reports
`reused`). This replaces the manual protocol of hand-copying `spec/*.json` + `.pi/state.json` between run
dirs to build verification arms.

- **`--baseline`** forks the baseline's frozen upstream artifacts + `.pi/state.json` into the new run's
  canonical home (the journal is dropped so the windowed tail re-runs; the `--from` pin + the resume
  preflight freeze and verify the prefix). A run id resolves under the template's canonical `runs/` home, or
  an explicit path is accepted; a missing/incomplete baseline is a loud, specific error, never a silent
  partial seed.
- **`--stage-only`** (valid only with `--baseline`) seeds the run dir and STOPS — no model — so a caller can
  pin/place a file (e.g. `spec/hook-menu.json`) into the staged dir, then launch the live window with a
  normal `run --run <id> --from <node> …`. The pin survives: both the baseline seed and the runtime seed
  staging skip already-filled destinations.
- **`@piflow/core`** gains `stageBaselineRun(baselineDir, destDir)` — the shared "fork a completed run's
  durable state into a fresh run dir" primitive (bundle-minus-journal → skip-filled unpack). `spawnChildRun`
  now uses this SAME primitive instead of its own inline pack/unpack, so the replay and the CLI baseline path
  share one seed implementation. `unpackRunDir` gains a `skipFilled` option (default overwrite, back-compat).

A run with no `--baseline` is byte-identical to before.

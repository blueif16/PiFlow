---
"@piflow/core": patch
"@piflow/cli": minor
---

Add an explicit, human-invoked way to force-close a STUCK run — closing the residual gap the already-merged
live orphan-detection (`readRunModel`'s controller-liveness check) can't resolve on its own: a `!done` run
with no `controllerPid` ever recorded (predates the field, or died before its first status write), or a
`frozen:true` run whose resume never came.

- **`@piflow/core`**: new `finalizeRun(dir, { ok? })` primitive (`runner/finalize.ts`) — reads a run's
  `.pi/run.json`, refuses (no write) when it is already `done:true`, otherwise writes `done:true, ok:
  opts.ok ?? false` via the existing `writeStatus` (never a raw file write), preserving every other field
  verbatim.
- **`@piflow/cli`**: `piflowctl node <run> --finalize [--ok=true|false]` — a single, explicitly-named run
  (no nodeId needed; naming the run IS the confirmation), resolved via the same `resolveNodeRunDir` every
  other `node` action uses. Prints old state → new state.
- **`@piflow/cli`**: `piflowctl runs sweep [--dry-run|--apply] [--include-frozen] [--json]` — a
  REGISTRY-WIDE audit (every registered product, not one workflow) that classifies every `!done` run into
  `auto-heals` (already self-healed by live detection; never written here), `stuck-no-pid`, or `frozen`.
  Default `--dry-run` (writes nothing); `--apply` finalizes `stuck-no-pid` runs (plus `frozen` ones only
  when `--include-frozen` is also passed), always through the same core `finalizeRun` primitive.

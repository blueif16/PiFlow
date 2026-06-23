// pi-runner hook-op engine — PUBLIC BARREL.
//
// The deterministic, behavior-preserving hook-op engine extracted from pi-runner/run.mjs (Phase 1 of the
// game-omni → @piflow/core convergence; design/sdk-convergence-migration.md). run.mjs keeps its own copies
// and stays the live engine; this package is the run.mjs-globals-free copy a future SDK consumer binds to.
//
// THE CTX CONTRACT — what was parameterized out of run.mjs's module globals:
//   ctx = {
//     runCwd,  // run.mjs RUN_CWD  — where the model executes + relative artifact paths resolve
//     root,    // run.mjs ROOT     — the repo root (the workflow's ROOT)
//     here,    // run.mjs HERE     — the pi-runner/ dir (only the schema-validator loader scans it)
//   }
// `projectBase` (run.mjs PROJECT_BASE) was ALREADY an explicit argument to the run*/apply* functions in
// run.mjs (callers pass `PROJECT_BASE || RUN_CWD`), so it stays a positional param, not part of ctx.
//
// The four marker families, each: parse-marker (pure or +ctx) → run-* (POST/PRE hook, +projectBase +ctx):
//   DRIVER-SEED           driverSeed(prompt)                         + resolveSeedTokens(spec, ctx)
//   DRIVER-PROJECT        driverProject(prompt, ctx)                 + runProjection(proj, projectBase, ctx)
//   DRIVER-MERGE          driverMerge(prompt)                        + runMerge(spec, projectBase, ctx)
//   DRIVER-SEED-CONTRACT  driverSeedContract(prompt)                 + runSeedContract(proj, projectBase, ctx)

export {
  ensureDir, projJson, drillPath, dedupSort,
  ASSET_DIR_BY_TYPE, ASSET_EXT_BY_TYPE, assetDefaultPath,
  markerPaths, markerValue, decodeB64Marker,
} from "./markers.mjs";

export { loadSchemaValidatorFactory, __resetSchemaValidatorMemo } from "./schema.mjs";

export { driverSeed, resolveSeedTokens } from "./seed.mjs";

export { driverProject, applyProjectionOp, runProjection } from "./project.mjs";

export { driverMerge, mergeResolveAbs, applyMergeOp, runMerge } from "./merge.mjs";

export {
  driverSeedContract, drillArrayField, coreObservables, gatherEntityIds,
  resolveNodeContract, runSeedContract,
} from "./seed-contract.mjs";

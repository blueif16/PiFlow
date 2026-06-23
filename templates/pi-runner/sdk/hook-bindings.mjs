// pi-runner SDK bridge — marker → @piflow/core Hook factory.
//
// The workflow-intake port (parse-claude-workflow.mjs) STRIPS every DRIVER-* line and never emits a
// node's `hooks` — so the SDK loses game-omni's deterministic hook ops. This module re-attaches them:
// it parses the four DRIVER hook families from the RAW (un-stripped) node prompt and builds an
// @piflow/core `Hook` whose `run` binds to the matching executor in pi-runner/hooks/.
//
// Firing order mirrored from run.mjs runNode (design/sdk-convergence-phase2.md):
//   PRE  (when:'always')      DRIVER-SEED           → stage each <dest> <= <src> before the model spawns
//   POST (when:'on-success')  DRIVER-PROJECT        → runProjection (the CLEAN-EXIT genre derive)
//   POST (when:'on-success')  DRIVER-MERGE          → runMerge
//   POST (when:'on-success')  DRIVER-SEED-CONTRACT  → runSeedContract
// CLEAN-EXIT (run.mjs's POST gate) ≡ Hook.when 'on-success'.
//
// TWO DISTINCT BASES (this is the parity crux — run.mjs keeps them separate):
//   • RUN_CWD (= ctx.runCwd/root, the repo root where pi runs) resolves EVERY repo-relative marker path:
//     the seed to/from, the {jsonfile:field} token files, the DRIVER-PROJECT source/mapRef, op schemas.
//     The realized markers are all repo-relative — project paths carry the projectDir prefix (e.g.
//     `out/<run>/spec/blueprint.json`), templates are `templates/...` — so ONE base (repo root) resolves
//     them all. Resolving these against the project dir would look for `templates/` under the project dir
//     and silently skip every seed.
//   • PROJECT_BASE (= resolveProjectBase(), the projectDir absolute) is what the POST executors
//     (runProjection/runMerge/runSeedContract) write their op `to` paths under, and what substitutes the
//     {project} placeholder. It is NOT RUN_CWD (the game is built under out/<run>; pi runs at the repo root).

import fs from "node:fs";
import path from "node:path";
import {
  driverSeed,
  resolveSeedTokens,
  driverProject,
  runProjection,
  driverMerge,
  runMerge,
  driverSeedContract,
  runSeedContract,
  ensureDir,
} from "../hooks/index.mjs";

// Stage one node's DRIVER-SEED entries (the PRE family). There is no packaged "stage seeds" executor in
// hooks/ — the copy loop lives inline in run.mjs (runNode, the DRIVER-SEED pre-stage block); this is a
// faithful, behavior-preserving replica built on the exported `driverSeed` parser + `resolveSeedTokens`.
// PARITY: run.mjs resolves the seed `to`, the `from`, AND the token files all against RUN_CWD (the repo
// root) — `path.resolve(RUN_CWD, …)`. Each entry stages ONLY when its dest is absent/empty AND its
// resolved src exists; entries apply IN ORDER (a base copy before an overlay that wins). A dir src is
// copied recursively; a file src as a file. The idempotency test is per-SOURCE (a seed whose dest shares
// a populated dir is still staged).
async function stageSeeds(seeds, runCwd) {
  for (const seed of seeds) {
    const toAbs = path.isAbsolute(seed.to) ? seed.to : path.resolve(runCwd, seed.to);
    const fr = resolveSeedTokens(seed.from, { runCwd });
    const fromAbs = path.isAbsolute(fr) ? fr : path.resolve(runCwd, fr);
    let srcIsDir = false, srcExists = false;
    try { srcIsDir = fs.statSync(fromAbs).isDirectory(); srcExists = true; } catch {}
    let destFilled = false;
    try {
      const ds = fs.statSync(toAbs);
      if (srcIsDir && ds.isDirectory()) {
        const want = fs.readdirSync(fromAbs);
        destFilled = want.length > 0 && want.every((e) => fs.existsSync(path.join(toAbs, e)));
      } else if (!srcIsDir) {
        destFilled = ds.size > 0;
      }
    } catch {}
    if (destFilled || !srcExists) continue;
    if (srcIsDir) { ensureDir(toAbs); fs.cpSync(fromAbs, toAbs, { recursive: true, force: true }); }
    else { ensureDir(path.dirname(toAbs)); fs.copyFileSync(fromAbs, toAbs); }
  }
}

// nodeHooks(rawPrompt, ctx, resolveProjectBase) → { pre:Hook[], post:Hook[] }.
//   rawPrompt          : the UN-stripped node prompt (carries the DRIVER-* lines).
//   ctx                : { runCwd, root, here } — the STATIC run context.
//                          runCwd/root = RUN_CWD (repo root); here = the ajv-bearing dir (pi-runner/).
//   resolveProjectBase : optional (hctx:HookContext) => string → PROJECT_BASE (the projectDir, absolute).
//                          The entrypoint always supplies it; falls back to hctx.workspace then runCwd.
export function nodeHooks(rawPrompt, ctx = {}, resolveProjectBase) {
  const pre = [];
  const post = [];
  const runCwd = ctx.runCwd ?? ctx.root ?? ".";
  // The ctx the POST executors take: runCwd/root resolve repo-relative mapRef/source/schema/{root};
  // here resolves ajv. NOT re-pointed at the project base (that was the conflation bug).
  const execCtx = { runCwd, root: ctx.root ?? runCwd, here: ctx.here ?? runCwd };
  const projectBaseOf = (hctx) => {
    const p = (typeof resolveProjectBase === "function" ? resolveProjectBase(hctx) : undefined)
      ?? hctx?.workspace ?? runCwd;
    if (!p) throw new Error("nodeHooks: cannot resolve projectBase (no resolveProjectBase, hctx.workspace, or ctx.runCwd)");
    return p;
  };

  // ── PRE: DRIVER-SEED (when:'always') — staged against RUN_CWD (repo root) ──────────────────────
  const seeds = driverSeed(rawPrompt);
  if (seeds.length) {
    pre.push({
      id: "seed", phase: "pre",
      inputs: seeds.map((s) => s.from), outputs: seeds.map((s) => s.to),
      when: "always", failure: "warn",
      run: async () => { await stageSeeds(seeds, runCwd); },
    });
  }

  // ── POST: DRIVER-PROJECT (when:'on-success') ──────────────────────────────────────────────────
  // Parse the static fields here, but DEFER the genreToken {jsonfile:field} resolution to FIRE time (vs
  // RUN_CWD, after classification.json exists) — resolving it at build time leaves it verbatim and the
  // projection silently skips (the 2a62eb3 failure class). projectBase = PROJECT_BASE (op `to` writes).
  const projStatic = driverProject(rawPrompt, { runCwd: " __no_resolve__" });
  if (projStatic) {
    post.push({
      id: "project", phase: "post", inputs: [projStatic.source], outputs: [],
      when: "on-success", failure: "warn",
      run: async (hctx) => {
        const proj = driverProject(rawPrompt, { runCwd }); // resolve the genreToken at FIRE time vs repo root
        if (proj) await runProjection(proj, projectBaseOf(hctx), execCtx);
      },
    });
  }

  // ── POST: DRIVER-MERGE (when:'on-success') ────────────────────────────────────────────────────
  const mergeSpec = driverMerge(rawPrompt);
  if (mergeSpec) {
    const tos = Array.isArray(mergeSpec.ops)
      ? mergeSpec.ops.map((o) => o && (o.concat?.to ?? o.reconcile?.to ?? o.fold?.to ?? o.to)).filter(Boolean)
      : [];
    post.push({
      id: "merge", phase: "post", inputs: [], outputs: tos,
      when: "on-success", failure: "warn",
      run: async (hctx) => { await runMerge(mergeSpec, projectBaseOf(hctx), execCtx); },
    });
  }

  // ── POST: DRIVER-SEED-CONTRACT (when:'on-success') ────────────────────────────────────────────
  const seedContract = driverSeedContract(rawPrompt);
  if (seedContract) {
    post.push({
      id: "seed-contract", phase: "post",
      inputs: [seedContract.catalog, seedContract.source].filter(Boolean),
      outputs: [seedContract.source].filter(Boolean),
      when: "on-success", failure: "warn",
      run: async (hctx) => { await runSeedContract(seedContract, projectBaseOf(hctx), execCtx); },
    });
  }

  return { pre, post };
}

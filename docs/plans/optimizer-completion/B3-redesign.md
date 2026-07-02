# B3-redesign — Long-horizon redesign subgraph + --generations CLI

- **Cluster:** B-big-rock
- **Effort:** medium
- **Needs sign-off:** YES
- **Depends on:** —
- **Shared-file risks:** packages/cli/src/optimize-fix.ts — A2-distiller may also add an OptimizeBinding field (e.g. distiller?); coordinate the interface block edits to avoid a merge conflict · packages/cli/src/optimize-loop.ts — B1-pareto could touch the loop CLI composition; coordinate if both edit runOptimizeLoopCli
- **Files touched:** packages/cli/src/optimize-fix.ts · packages/cli/src/optimize-loop.ts · packages/cli/src/cli.ts · packages/cli/test/optimize-loop-cli.test.ts · packages/cli/test/fixtures/fake-loop-redesign-binding.mjs · docs/design/long-horizon-redesign.md

**Open questions:**
- Seed templateDir + how the product `run(round)` learns which generation's workflow to run: binding.run currently takes only `round` and reads its workflow from env/cwd. For multi-generation to optimize W→W', run must key off the generation's template. Recommended default: thread the templateDir via an env var the binding reads (or a --template CLI positional), and let redesign's nextTemplate become the next env value; for this task's fake-binding test a placeholder seed string suffices.
- Redesign authority + safety envelope (self-design positioning): may the redesign subgraph author an arbitrary DAG, or is it bounded to stamping a blueprint shape? Recommended default: bound to a blueprint stamp gated by `piflowctl extract` exiting 0, never overwriting the incumbent template — the loop-never-mutates-a-live-file invariant lifted to the outer loop.

---
## 1. Objective / Definition of Done

Wire the already-built-but-uncalled long-horizon OUTER loop (`runLongHorizon`, core `packages/core/src/optimize/long-horizon.ts:84`) into the CLI so `piflowctl optimize --generations N --rounds M --binding <module>` runs N generations of the inner multi-round loop, threading each redesign's `nextTemplate` into the next generation. Deliver TWO pieces:

1. **CLI WIRE (this repo, in-scope now):**
   - Add an OPTIONAL `redesign?: RedesignStage` field to `OptimizeBinding` (`packages/cli/src/optimize-fix.ts:19-37`).
   - Parse `--generations N` into `ParsedOptimizeLoopArgs` + `parseOptimizeLoopArgs` (`packages/cli/src/optimize-loop.ts:30-71`).
   - Refactor `runOptimizeLoopCli` so the "run one multi-round loop over a given `templateDir`" body becomes a reusable `runGeneration(gen, dir)` closure, then compose `runLongHorizon({ runGeneration, redesign: binding.redesign }, { templateDir, maxGenerations })` when `--generations > 1`. Keep the `--generations 1` (default) path byte-for-byte equivalent to today's single-generation output (no behavior change for existing callers).
   - Print a generation-by-generation trajectory + the long-horizon stop reason.

2. **PRODUCT-SIDE redesign subgraph (design + author-time contract; DEFERRED implementation pending sign-off):** a real `RedesignStage` an author drops into the game-omni binding (`/Users/tk/Desktop/game-omni/packages/verify/optimize/binding-live.mjs`) — a `claude -p` agent (mirroring the existing `fixer`) that reads the completed generation's run history + `loopResult`, then AUTHORS the next workflow's template by stamping the blueprints layer (`.claude/skills/piflow-init/references/blueprints/`) + the ARCH/reconcile (L2 COMPOSE) path, and returns `{ done, nextTemplate, rationale }`.

**DoD:**
- `parseOptimizeLoopArgs(['--binding','b','--generations','3','--rounds','2'])` returns `generations: 3, rounds: 2`; absent flag ⇒ `generations` defaults to 1 (or `undefined` → treated as 1).
- With a fake binding exporting `run` + `redesign`, `runOptimizeLoopCli(['--generations','2', …])` runs the inner loop twice (on W then W'), and the printed output names both generations + the long-horizon stop reason.
- With `--generations` absent (or `1`), the output is IDENTICAL to today (single generation; the existing 3 optimize-loop-cli tests still pass unchanged).
- `--generations > 1` on a binding with NO `redesign` export runs exactly ONE generation and reports `no-redesign-seam` (honest stop — inherited from `runLongHorizon`).
- Core is untouched (`runLongHorizon` + all long-horizon types already exist and are exported at `packages/core/src/optimize/index.ts:50-54` and re-exported from `packages/core/src/index.ts:408,416-417`). If core needs ANY change, that is a red flag — STOP.
- The redesign subgraph design doc exists and is signed off; its implementation is authored product-side (game-omni), NOT in this repo's `packages/*`.

## 2. Invariants honored (cite each)

- **Model proposes/scores; code decides/bounds/lands.** The CLI wire adds ZERO intelligence — it only sequences `runLongHorizon` (deterministic outer driver) over the existing deterministic `runOptimizeLoop`. All "analyze-past → design-next" intelligence lives in the injected `redesign` stage (product-side `claude -p`), exactly as the fixer does. `long-horizon.ts:15-16` states this contract.
- **The loop never mutates a live file.** `runLongHorizon` only SEQUENCES generations and threads a `nextTemplate` POINTER string (`long-horizon.ts:109`); it writes nothing. The redesign subgraph, when it authors a NEW template, writes it to a NEW dir (a fresh generation's `templateDir`), never mutating the incumbent W in place — the CLI never adopts/lands. Landing an inner-loop fix stays the separate out-of-loop `--auto-adopt`/adopt step (unchanged). This is the outer analogue of the loop invariant: designing W' is producing a new artifact, not editing W.
- **SDK boundary law.** `redesign?` rides `OptimizeBinding` (CLI/product seam, `optimize-fix.ts`), NOT core. The `claude -p` call lives in the game-omni binding, injected into core's `runLongHorizon` via the CLI — same pattern as `fixer`/`run`. `@piflow/core` stays product-agnostic; no new core code.
- **Pointer + resolve-at-read.** Untouched by this task — the redesign stage operates at the workflow-template granularity, above the per-node Leg-A/Leg-B lesson↔slice cross-reference. The redesign prompt MAY read `understand`/`memory-slices` output as INPUT, but emits a template pointer, storing no embedded copy.
- **Test-first + mutation-verified.** The load-bearing test is written before the wire; §6 gives it a concrete test-the-test mutation. No test asserts unobservable intent (we assert which templateDir each generation optimized + the stop reason, both observable), and none is fit to current output (the fake binding drives real generation threading).

## 3. Files to change (exhaustive)

**In-scope now (CLI wire):**
- `packages/cli/src/optimize-fix.ts` — add `redesign?: RedesignStage` to `OptimizeBinding` (import the type from `@piflow/core`). `loadBinding` validation is UNCHANGED (redesign is optional, like `run`/`readFixCycles`; only `oracle`/`copyScope`/`fixer` stay required at lines 95-97).
- `packages/cli/src/optimize-loop.ts` — add `generations?: number` to `ParsedOptimizeLoopArgs`; add the `--generations` branch to `parseOptimizeLoopArgs`; refactor `runOptimizeLoopCli` to extract a `runGeneration(gen, dir)` closure and compose `runLongHorizon` when generations > 1; extend the final print with the generation trajectory.
- `packages/cli/src/cli.ts` — NO change needed to dispatch: `optimize` with `--generations` still contains `--rounds` in practice, but to be safe, confirm the router at `cli.ts:265-272` routes `--generations` to `runOptimizeLoopCli`. Since the router keys on `--rounds`/`--fix`, ADD `--generations` to the `--rounds` branch condition: `if (rest.includes('--rounds') || rest.includes('--generations'))` so `--generations N` alone (rounds defaulting to 1) still reaches the loop CLI.

**Test files (in-scope now):**
- `packages/cli/test/optimize-loop-cli.test.ts` — add the `--generations` parse cases + the multi-generation composition case (the load-bearing test).
- `packages/cli/test/fixtures/fake-loop-redesign-binding.mjs` — NEW fixture: extends `fake-loop-binding.mjs` with a `redesign` export that hands off to a fresh template dir for gen 1 then converges, so the CLI test can observe generation threading + stop.

**Product-side (DEFERRED, pending sign-off; NOT in this repo's packages):**
- `/Users/tk/Desktop/game-omni/packages/verify/optimize/binding-live.mjs` — author the `redesign` export (a `claude -p` subgraph) + export it.
- `docs/design/long-horizon-redesign.md` (this repo, docs only) — the redesign subgraph contract/design doc for sign-off (no code).

## 4. Step-by-step plan

**Step 0 — Confirm the seam is intact (read-only, no edit).** Re-verify `runLongHorizon`'s signature and `LongHorizonStages` shape (`long-horizon.ts:44-51,84`): `runGeneration(generation, templateDir) => Promise<OptimizeLoopResult>` and optional `redesign`. Confirm `OptimizeLoopResult` is what `runOptimizeLoop` returns (`loop.ts:65-72`) — yes, `runGeneration` will return exactly the value `runOptimizeLoop` produces today. Confirm the core exports (`index.ts:408,416-417`).

**Step 1 — Type: `redesign?` on `OptimizeBinding`.** In `optimize-fix.ts`, import `RedesignStage` from `@piflow/core` (add to the `import type { … }` at line 15). Add the field after `run?` (line 29) with a doc comment: `/** OPTIONAL: the long-horizon redesign subgraph — analyze a completed generation and author the NEXT workflow's template. Product-side self-design (boundary law); the multi-generation --generations N loop threads its nextTemplate. Absent ⇒ one generation then stop (no-redesign-seam). */`. Do NOT add it to `loadBinding`'s required-key loop (line 95) — it stays optional.

**Step 2 — Parse `--generations N`.** In `optimize-loop.ts`: add `/** M — the GENERATION budget for the long-horizon outer loop (default 1 = today's single-generation behavior). */ generations?: number;` to `ParsedOptimizeLoopArgs` (after `rounds`, ~line 33). In `parseOptimizeLoopArgs`, add the branch: `else if (k === '--generations') out.generations = Number(argv[++i]);` (alongside `--rounds`, line 56). Leave the default UNSET (undefined) — the composition treats undefined/≤1 as single-generation.

**Step 3 — Refactor `runOptimizeLoopCli` to extract `runGeneration`.** Today lines 118-148 build `currentRunDir`, `stages`, and call `runOptimizeLoop`. Wrap that block in a closure:
```
const runGeneration = async (_gen: number, templateDir: string): Promise<OptimizeLoopResult> => {
  // NOTE: `templateDir` is the generation's workflow; the product `run(round)` produces each round's run dir
  // FROM it. The existing binding.run signature is run(round) — it reads the workflow from its own env/cwd, so
  // for a single-generation loop templateDir === opts.templateDir and run is unchanged. See Open Question #1.
  let currentRunDir = '';
  const stages: OptimizeLoopStages<string> = { /* the existing composition, verbatim */ };
  return runOptimizeLoop(stages, { rounds: args.rounds, …existing opts… });
};
```
The `run`/`scoreAndTriage`/`fixGate`/`memorize` composition (lines 125-141) moves inside verbatim; `currentRunDir` becomes loop-local per generation (correct — each generation's rounds are sequential, no interleaving, same rationale as the existing comment at 117-120). Import `runLongHorizon` + `type OptimizeLoopResult` from `@piflow/core` (add to lines 24-25).

**Step 4 — Compose `runLongHorizon` for N generations.** After building `runGeneration`, branch:
```
const generations = (args.generations !== undefined && args.generations > 1) ? args.generations : 1;
if (generations > 1) {
  const lh = await runLongHorizon(
    { runGeneration, ...(binding.redesign ? { redesign: binding.redesign } : {}) },
    { templateDir: <the seed workflow dir>, maxGenerations: generations },
  );
  // print the generation trajectory + lh.stoppedReason (see Step 5)
  return;
}
// else: the existing single-generation path — call runGeneration(1, seedDir) directly and print as today.
```
Keep the single-generation path calling `runGeneration(1, seedDir)` and rendering EXACTLY the current summary (lines 151-156) so existing tests/output are byte-stable. The seed `templateDir`: see Open Question #1 — recommended default is the binding's own workflow (pass the binding spec's resolved template dir, or accept an explicit positional/`--template`); for the fake-binding tests, a placeholder string suffices because the fake `run` ignores it.

**Step 5 — Render the generation trajectory.** For the multi-generation path, print one line per generation: `generation ${g.generation} (${g.templateDir}): ${g.loopResult.roundsRun} round(s), ${accepted} edit(s), inner-stop ${g.loopResult.stoppedReason}${g.plan ? ' → ' + g.plan.rationale : ''}`, then a summary `optimize --generations ${generations}: ${lh.generationsRun} generation(s) run, stopped: ${lh.stoppedReason}; nothing landed live (adopt is a separate step).` to stderr. This mirrors the inner-loop rendering (lines 151-156).

**Step 6 — Dispatch.** In `cli.ts:269`, change `if (rest.includes('--rounds'))` → `if (rest.includes('--rounds') || rest.includes('--generations'))` so `--generations N` (with default rounds 1) reaches `runOptimizeLoopCli`. Update the routing comment (266-268) to name `--generations` as the long-horizon path.

**Step 7 — Product-side redesign design doc (docs only, for sign-off).** Write `docs/design/long-horizon-redesign.md` invoking the `agentic-prompt-design` skill: it specifies the `RedesignStage` implementation as a `claude -p` agent (deep tier, resolved like the fixer's `resolveFixerModel`) whose prompt (a) reads the generation's run history under `templateDir` + a distilled `loopResult` summary (roundsRun, trajectory, stoppedReason), (b) reads the blueprints catalog (`~/.piflow/blueprints/`) + the ARCH/reconcile L2-COMPOSE guidance, (c) DECIDES done vs. keep-going, (d) if keep-going, STAMPS the next template into a NEW dir via `piflowctl new`/`add-node` + Write (the blueprint contract, README steps 3-6), (e) returns `{ done, nextTemplate: <new dir>, rationale }`. Include the acceptance bar (extract exits 0 on the authored template; never overwrites the incumbent; a redesign that authors NOTHING returns `{ done: true }` honestly). This doc is the sign-off artifact — its implementation lands in game-omni AFTER sign-off, out of this repo's packages.

**Step 8 — Author the game-omni redesign export (DEFERRED to post-sign-off).** In `binding-live.mjs`, add + export `redesign(input)` per the doc. Not part of this repo's diff.

## 5. Test-first plan (the load-bearing test FIRST)

Write these in `packages/cli/test/optimize-loop-cli.test.ts` BEFORE the wire.

**Parse tests (cheap guards):**
- `parseOptimizeLoopArgs(['--binding','./b.mjs','--generations','3','--rounds','2'])` ⇒ `generations === 3 && rounds === 2`.
- absent ⇒ `generations === undefined` (default handled downstream as 1).

**Load-bearing test — multi-generation composition threads the redesign's nextTemplate:**
Add `FAKE_REDESIGN = fixtures/fake-loop-redesign-binding.mjs` — exports `run(round)` (mkdtemps a run dir, seeds the M2 report like `fake-loop-binding.mjs`) AND `redesign({ generation, templateDir, loopResult })` that returns, for generation 1, `{ done: false, nextTemplate: <a distinct marker dir, e.g. `${templateDir}::gen2`>, rationale: 'designed gen 2' }` and for generation ≥ 2 `{ done: true, rationale: 'converged' }`. The fixture records into a module-level array (or writes a sentinel file per generation) which `templateDir` each `redesign` call SAW.
The test runs `runOptimizeLoopCli(['--binding', FAKE_REDESIGN, '--generations','3','--rounds','1', …], { scoreRun: fakeScoreRun('w4-execute-m2'), print })` and asserts:
1. The printed output names BOTH generation 1 and generation 2 (`/generation 1/` and `/generation 2/`).
2. The long-horizon stop reason is `converged` (redesign returned done at gen 2), NOT `generation-budget` — proving the redesign's `done` was actually threaded through `runLongHorizon`.
3. Generation 2 optimized the template redesign authored in gen 1 (the fixture asserts its recorded `templateDir` for the gen-2 redesign call ends with `::gen2`, or the printed gen-2 line contains the `::gen2` marker) — proving `nextTemplate` was threaded into the next generation, not ignored.

**No-redesign honest-stop test:** run `--generations 3` on `FAKE_RUN` (the existing fixture with NO `redesign`) ⇒ output shows exactly ONE generation and the stop reason `no-redesign-seam`; `run` was invoked for round 1 only of one generation.

**Back-compat test (the guard against breaking existing callers):** the existing three `runOptimizeLoopCli` tests (lines 74-131) MUST pass unchanged — running WITHOUT `--generations` still prints the round trajectory + `budget-exhausted` as today. (This is the anti-regression floor; do not modify those tests.)

## 6. Test-the-test (mutation that MUST make the load-bearing test fail)

Mutation A (threading is a no-op): in `runOptimizeLoopCli`'s multi-generation path, hardcode the seed `templateDir` for EVERY generation instead of threading `runLongHorizon`'s `plan.nextTemplate` — i.e. bypass `runLongHorizon` and just loop `runGeneration(g, seedDir)` N times ignoring redesign. Assertion #2 (`stopReason === 'converged'`) and #3 (`gen-2 optimized the ::gen2 template`) MUST fail — because without `runLongHorizon`, the redesign's `done`/`nextTemplate` are never consulted, so the loop runs the full budget on the SAME template and never converges. If this mutation still passes, the test is asserting only that "two generations printed," not that redesign was actually driving — strengthen assertion #3 to check the gen-2 line carries the `::gen2` marker.

Mutation B (default regression): make `--generations` absent silently take the multi-generation branch with generations=1 but through `runLongHorizon` instead of the direct single-generation render. The back-compat tests MUST fail if the summary line wording changes (e.g. "generation" vs "round"). This proves the default path is genuinely byte-stable.

## 7. Coupling / coordination

- **dependsOn none for the CLI wire** — `runLongHorizon` + the long-horizon types are already built, tested, and exported. The wire is additive.
- **Shared-file risk with A2-distiller / B1-pareto:** those tasks change `CandidateEdit`/`FixGateResult` in `packages/core/src/optimize/driver.ts` and may touch `OptimizeBinding` if the distiller rides the binding. B3 touches `OptimizeBinding` in `optimize-fix.ts` (adds `redesign?`) — a DIFFERENT field, additive, low collision risk, but if A2 also adds a binding field (e.g. `distiller?`), coordinate the interface edits to avoid a merge conflict on the `OptimizeBinding` block. B3 does NOT touch `driver.ts`, so it does not collide on the `CandidateEdit`/`FixGateResult` type changes.
- **B4-fixer coupling:** the redesign subgraph reuses the fixer's `claude -p` + `resolveFixerModel` + watchdog patterns (product-side, game-omni `binding-live.mjs`). If B4 refactors that binding's fixer plumbing, the redesign author should reuse the refactored helpers — flag to whoever lands B4 first. Not a hard dependency (B3's product-side piece is deferred + separate export).
- **Blueprints layer:** B3's redesign composes on `.claude/skills/piflow-init/references/blueprints/` — read-only consumer; no edit to the blueprints. If the blueprints contract changes elsewhere, the redesign prompt's stamping steps must track it.

## 8. Rollout / verification

- After the CLI wire: `npm run typecheck` (or the workspace's tsc) + `npx vitest run packages/cli/test/optimize-loop-cli.test.ts` + the core long-horizon suite `npx vitest run packages/core/test/optimize-long-horizon.test.ts` (must stay green — unchanged). Confirm the full CLI test package is green (no back-compat break).
- Do NOT run a live `--generations` against game-omni until the redesign export is authored + signed off — until then, `--generations N` on the game-omni binding (which has no `redesign`) honestly reports `no-redesign-seam` after one generation, which is the correct interim behavior.
- Commit boundaries: (1) type + parse (redesign? field, --generations parse) with the parse tests; (2) the runGeneration refactor + runLongHorizon composition + dispatch, with the load-bearing test; (3) the design doc. Three coherent commits, no mega-commit.

## 9. Risks / open decisions

- **Seed templateDir source (Open Question #1):** `runLongHorizon` needs a starting `templateDir`, but the existing `binding.run(round)` signature takes only `round` and reads the workflow from its own env/cwd — it does NOT accept a templateDir. For multi-generation to actually optimize DIFFERENT workflows W → W', the product `run` must eventually key off the generation's template. Recommended default: (a) thread the templateDir as an env var the binding's `run` reads, OR (b) accept the seed dir as a positional/`--template` on the CLI and let the redesign's `nextTemplate` become the next env value. For THIS task's scope (the wire + fake-binding test), a placeholder seed string is sufficient (the fake `run` ignores it); the real product wiring of "run reads the generation's template" is the redesign author's concern, called out in the design doc. Flag for user decision.
- **Self-design positioning (needsSignoff = true):** authoring the next workflow is the product's self-designing-substrate claim (product positioning memory: LEAD with self-design→sealed→self-improving). The redesign subgraph's authority (may it author an arbitrarily different DAG? bounded to blueprint shapes only?) and its safety envelope (extract-green gate, never overwrite incumbent) are design decisions needing sign-off before the game-omni implementation lands. Recommended default: bound generation-1 redesign to STAMP a blueprint shape (not free-form graph synthesis), gated by `piflowctl extract` exiting 0, never mutating the incumbent template.

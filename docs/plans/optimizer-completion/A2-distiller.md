# A2-distiller — Wire the distiller into MEMORIZE (+ capture fixer root-cause)

- **Cluster:** A-loop-tail
- **Effort:** medium
- **Needs sign-off:** no
- **Depends on:** B1-pareto
- **Shared-file risks:** packages/core/src/optimize/driver.ts edited by B1-pareto (both change CandidateEdit + FixGateRecord; A2 adds an optional foundRoot field, B1 makes records set-valued — land A2 first as it is purely additive)
- **Files touched:** packages/core/src/optimize/driver.ts · packages/core/src/optimize/land.ts · packages/cli/src/optimize-fix.ts · packages/cli/src/optimize-loop.ts · packages/core/test/optimize-distill-wire.test.ts · packages/cli/test/optimize-fix.test.ts

**Open questions:**
- Separate injected binding.distill vs. fold distillation into binding.fixer's return — recommended default: separate optional distill export (cheaper, differently-shaped prompt than the fixer).
- Distill on 'update' lesson rows too, or only 'append' — recommended default: only 'append' (updates are materialize-only by design; re-distilling churns curated prose).
- Surface foundRoot on the staging manifest.json — recommended default: yes (durable, non-breaking, human-useful even when no distiller is injected).

---
## 1. Goal / Definition of Done

`distillLesson` (packages/core/src/optimize/distill.ts:87) is built + unit-tested but has **no live caller**. MEMORIZE appends lesson blocks with honest `(pending — the fixer fills…)` Root/Prevention placeholders (memorize.ts:153-154) that **never get filled** because (a) the fixer's traced root cause is captured on no threadable type, and (b) neither the `--fix` path nor the loop calls `distillLesson`.

**Done when:**
1. A typed `foundRoot?: string` flows `CandidateEdit` (driver.ts:18) → `FixGateRecord` (driver.ts:86) → `FixGateResult.records` — so the fixer's found root reaches the CLI seam. Deterministic pass-through; no interpretation in core.
2. The `--fix` path (optimize-fix.ts) and the multi-round loop (optimize-loop.ts) call `distillLesson` **once per newly-APPENDED LAPSE/SKILL lesson** (the `action === 'append'` rows from the `MemorizeResult`), passing that node's `foundRoot` from the matching `FixGateRecord`.
3. The **real `claude -p` distiller** is injected at the CLI binding (a new optional `distill?` export on `OptimizeBinding`), never in core. Absent binding.distill ⇒ placeholders stay (graceful no-op, exactly today's behavior).
4. `deriveRecurrence` reads back the distilled Root/Prevention (the round-trip oracle) after a `--fix` run whose binding supplies a distiller.
5. Loop invariant honored: distillation is a fill of an already-written memory.md block (a memory *artifact*, off the live-file critical path) — NOT a live product-file mutation; it degrades to `skipped` on any distiller failure and never sinks a staged fix or a round.

## 2. Context / Current State (verified this run)

- **distill.ts:87-104** — `distillLesson(file, sig, defect, distiller, opts)` calls the injected `LessonDistiller` then `fillLessonProse`; degrades to `'skipped'` on throw/empty. `DistillLessonOpts.foundRoot` (distill.ts:45) and the distiller input `{defect, foundRoot}` (distill.ts:35-40) already exist. Exported from core (index.ts:390, optimize/index.ts:17).
- **memorize.ts:61-98** — `memorize(scores, defects, {runDir, templateDir})` returns `MemorizeResult { signaturesPath, lessons: MemorizeLesson[] }`. Each `MemorizeLesson` = `{ node, sig, recurrence, action: 'append'|'update', file }` (memorize.ts:32-40). The APPEND branch writes placeholders (153-154); UPDATE only materializes `recurrence:` (139-146).
- **triage.ts:40-63** — emits **exactly one Defect per node** (one loop iteration per NodeScore). So `node` is an unambiguous join key between a `FixGateRecord` and a `MemorizeLesson`.
- **driver.ts** — `CandidateEdit` (18-32) carries `editsApplied/candidatePassedProductChecks/tokensSpent/summary/aborted` only. `FixGateRecord` (86-96) carries no root cause. `runFixGate` builds records at driver.ts:206. The fixer's trace crumbs flow ONLY through the opaque `emit`/`fixer-trace` channel (driver.ts:36-39,169) — nothing typed.
- **The 3 live memorize call sites** all pass only `(scores, defects, {runDir, templateDir})`: optimize-fix.ts:240, optimize-loop.ts:138, optimize.ts:58. The read-only `optimize.ts --memorize` path (58) is OUT of scope — it has no fixer, so no `foundRoot` and nothing to distill (leave it writing placeholders).
- **land.ts:40-50** — `writeStagingManifest` destructures only named fields off each record; adding an optional `foundRoot` to `FixGateRecord` is non-breaking (and MAY optionally be surfaced on `ManifestRecord` for the human).
- **The binding is product-side** (game-omni), dynamic-imported by `loadBinding` (optimize-fix.ts:86-99), validated for `{oracle, copyScope, fixer}`. `binding.distill` will be OPTIONAL (do not add it to the required-export check — that would break every existing binding).

## 3. Invariants Honored (cite)

- **Model PROPOSES/SCORES; code DECIDES/BOUNDS/LANDS.** `foundRoot` is a passive string the driver copies edit→record with zero interpretation; `distillLesson` is called by the thin CLI seam after MEMORIZE already deterministically decided what to append. The model (distiller) only writes prose into an already-decided block.
- **Loop never mutates a live file.** Distillation fills a `memory.md` lesson block — a memory artifact, not a product/live file — and only for blocks MEMORIZE just appended. It is off the critical path (wrapped in try/catch that never fails a round or a staged fix), mirroring the existing memorize wrapping (optimize-fix.ts:239-247, optimize-loop.ts:136-139).
- **SDK boundary law.** The `claude -p` distiller lives PRODUCT-side (binding.distill), injected through the CLI seam; core keeps NO model/network/prompt. `distillLesson` in core takes an injected `LessonDistiller` exactly as designed.
- **Pointer + resolve-at-read.** Untouched — this task fills Leg-A `root`/`prevention` prose; the Leg-B `[[okf-slice]]` link and its resolve-at-read (`enrichCodeMap`, optimize-fix.ts:108) are unchanged.
- **test-first + mutation-verified.** Load-bearing test drives the whole `foundRoot` thread + the distill call from a real (fake-distiller) `--fix` composition; see §6.

## 4. Design / Approach

Three coordinated seams, smallest-to-largest blast:

**(A) Thread `foundRoot` through the driver types (core, driver.ts).**
- Add `foundRoot?: string` to `CandidateEdit` (after `summary`, driver.ts:24). Doc: "the fixer's traced root cause — a passive string the driver copies to the record; core never interprets it. Feeds the distiller at the CLI seam."
- Add `foundRoot?: string` to `FixGateRecord` (driver.ts:96). 
- At `records.push(...)` (driver.ts:206), spread `...(edit.foundRoot ? { foundRoot: edit.foundRoot } : {})` — conditional so a fixer that reports none produces a record with the field absent (keeps existing test snapshots/records byte-identical when unused). This is the **coordination point with B1-pareto** (see §7): both tasks edit `CandidateEdit`/`FixGateRecord` in driver.ts.
- OPTIONAL, low-risk: surface `foundRoot` on `ManifestRecord` (land.ts:24-33 + the map at 40-50) as `...(r.foundRoot ? { foundRoot: r.foundRoot } : {})` so the staged manifest records what the fixer found even when the distiller is absent. Recommend YES — it is a durable human-readable record and non-breaking.

**(B) Call `distillLesson` per newly-appended lesson (CLI, optimize-fix.ts).**
- Add an exported helper in optimize-fix.ts: `distillAppendedLessons(lessons, records, defects, distill, print?)`. It:
  1. Builds `rootByNode = new Map(records.map(r => [r.node, r.foundRoot]))` (one defect/node ⇒ one record/node; §2).
  2. Builds `defectByNode = new Map(defects.map(d => [d.node, d]))`.
  3. For each `lesson` with `action === 'append'`: look up its `defect` and `foundRoot` by `lesson.node`; call `await distillLesson(lesson.file, lesson.sig, defect, distill, foundRoot ? { foundRoot } : {})`. Skip an appended lesson with no matching defect (defensive; shouldn't happen).
  4. Wrap the whole thing so one distiller failure never propagates (distillLesson already returns `'skipped'` and never throws on a bad distiller, but guard the loop anyway).
- Why only `append`: an `update` row means the block already exists — its Root/Prevention are curated/already-distilled; re-distilling would churn curated prose (and the recurrence flip LAPSE→SKILL is a materialize-only path by design, memorize.ts:139-146). LAPSE/SKILL are the only RECORDABLE buckets (memorize.ts:59), so every appended lesson is already LAPSE/SKILL — the task's "per newly-appended LAPSE/SKILL lesson" is exactly the `append` set.

**(C) Inject the real distiller at the binding + wire both call sites.**
- Add `distill?: LessonDistiller;` to `OptimizeBinding` (optimize-fix.ts:19, importing `LessonDistiller` from `@piflow/core`). Doc it as OPTIONAL and product-side (`claude -p`); do NOT add it to the required-export check in `loadBinding` (95).
- In `runOptimizeFixCli` (optimize-fix.ts): after the existing `memorize(...)` call (240), if `binding.distill` is set, call `await distillAppendedLessons(lessons, result.records, defects, binding.distill, print)`. Keep it INSIDE the same off-critical-path try/catch (239-247) so a distiller failure is logged and swallowed, never sinking the already-staged fix. Add a one-line stderr summary ("distilled N of M appended lesson(s)").
- In the loop's `memorize` stage (optimize-loop.ts:135-140): the loop stage currently re-derives `scores/defects/templateDir` and calls `memorize`. Change it to also thread the round's `FixGateResult` so the distiller gets `foundRoot`. The `OptimizeLoopStages.memorize` signature already provides `(run, result, round)` (loop.ts:38) — but the CLI's current stage ignores `result`. Update the CLI stage to `memorize: async (runDir, result) => { ... const { lessons } = memorize(...); if (binding.distill) await distillAppendedLessons(lessons, result.records, defects, binding.distill); }`, all inside the existing try/catch (memory is advisory).
- The read-only `optimize.ts --memorize` path (58) is NOT touched — no fixer there, nothing to distill; its placeholders stay honest (a later `--fix` distills them).

**Why the injected distiller belongs on the binding, not a separate CLI flag:** the binding is already the single product→optimizer injection convention (optimize-fix.ts:18-37) carrying `oracle/copyScope/fixer/run`. The distiller is the same shape of product-side `claude -p` stage as `fixer`; putting it beside `fixer` keeps ONE injection surface and mirrors how `run` was added for the loop.

## 5. Step-by-step Execution

1. **(test-first)** Write the load-bearing test (see §6) in a new `packages/core/test/optimize-distill-wire.test.ts` (core, for the driver thread) AND extend `packages/cli/test/optimize-fix.test.ts` (or create it if absent — verify) for the CLI composition. Run; confirm they FAIL for the right reason (no `foundRoot` field / no distill call).
2. **driver.ts** — add `foundRoot?` to `CandidateEdit` + `FixGateRecord`; conditional-spread it into the `records.push` at 206. Typecheck.
3. **land.ts** (optional-recommended) — add `foundRoot?` to `ManifestRecord` + conditional map. Typecheck.
4. **optimize-fix.ts** — import `LessonDistiller`, `distillLesson`, `MemorizeLesson`, `FixGateRecord` types from `@piflow/core`; add `distill?` to `OptimizeBinding`; add + export `distillAppendedLessons`; call it after `memorize` in `runOptimizeFixCli` inside the existing try/catch.
5. **optimize-loop.ts** — update the `memorize` stage to accept `result`, re-derive `defects`, and call `distillAppendedLessons(lessons, result.records, defects, binding.distill)` when `binding.distill` is set, inside the existing try/catch.
6. Re-run all tests; confirm the load-bearing test now PASSES and the existing distill/memorize/driver tests are green.
7. Full package typecheck + the optimize test suite.
8. **Doc-comment the binding contract**: in the `OptimizeBinding.distill` doc, state it is the product's `claude -p` distiller, injected (core holds no model), and OPTIONAL (absent ⇒ placeholders remain). This is agent-facing prose the next binding-author reads — keep the "what/why/absent-behavior" bar.

## 6. Test Plan (test-first, mutation-verified)

**Load-bearing test — CLI composition (packages/cli/test/optimize-fix.test.ts):**
"a `--fix` run whose binding supplies a distiller fills the appended LAPSE lesson's Root/Prevention with the distiller's prose, and passes the fixer's foundRoot to it."
- Arrange: a temp `.piflow/<wf>/runs/<id>` + `template/` layout (reuse the distill test's `makeRunDir`/`seed` helpers pattern). Inject `deps.scoreRun` returning a LAPSE-shaped `NodeScore` + a matching digest; a fake binding whose `fixer` returns `{ editsApplied: 1, foundRoot: 'traced: empty artifact before write barrier' }` and whose `oracle/copyScope` make the gate reject (so nothing lands live — proves distill runs independent of accept/reject) OR accept (either is fine; distill keys off `append`, not landing). A fake `binding.distill` that echoes `{ root: \`R:${input.foundRoot}\`, prevention: 'P' }`.
- Act: run `runOptimizeFixCli(argv, deps)`.
- Assert (the ORACLE): `deriveRecurrence({templateDir, nodes:['flaky']}).get(sig)?.lesson?.root` === `'R:traced: empty artifact before write barrier'` and `.prevention` === `'P'`. This single assertion proves (i) the field threaded fixer→record, (ii) `distillAppendedLessons` matched by node, (iii) `distillLesson` filled the block, (iv) the round-trip reader sees it.
- **Test-the-test mutation (concrete):** in `distillAppendedLessons`, change the `foundRoot` lookup to pass `undefined` (drop the `rootByNode` wiring). The test must FAIL: root would read `'R:undefined'`, not `'R:traced: empty artifact…'`. A SECOND mutation: gate the distill call on `action === 'update'` instead of `'append'` — the block keeps `(pending`, `.lesson.root` reads the placeholder ⇒ test FAILS. If either mutation still passes, the test asserts nothing real.

**Supporting tests:**
- **driver thread (core, optimize-distill-wire.test.ts):** a fixer returning `foundRoot: 'X'` ⇒ `runFixGate(...).records[0].foundRoot === 'X'`; a fixer returning none ⇒ the record has NO `foundRoot` key (`'foundRoot' in record` is false). Mutation: hard-code `foundRoot: ''` in the push ⇒ the "absent" assertion fails.
- **graceful no-op:** a `--fix` run with `binding.distill` UNSET leaves the appended block's `(pending` placeholders intact (byte-for-byte on the block) and does not throw. Mutation: call `distillLesson` unconditionally with `undefined` distiller ⇒ throws/writes ⇒ test fails.
- **distiller failure is swallowed:** a `binding.distill` that throws ⇒ the `--fix` run still completes, the manifest is written, placeholders intact, exit code unchanged. (Leans on `distillLesson`'s existing degrade, but proves the CLI wrapper doesn't re-throw.)
- Do NOT add a test asserting the exact stderr summary wording (unobservable-intent / brittle) — assert only the memory.md round-trip + no-throw.

## 7. Coordination / Risks

- **SHARED FILE with B1-pareto: `packages/core/src/optimize/driver.ts`.** BOTH tasks change `CandidateEdit`/`FixGateRecord`. A2 ADDS one optional field (`foundRoot`) to each and one conditional spread at the single `records.push` (driver.ts:206). B1 makes candidates set-valued (records become an array-of-candidates / Pareto set). **Sequencing recommendation: land A2 FIRST** — it is a purely additive optional field with no structural change, so B1 can rebase its set-valued refactor on top and simply carry `foundRoot` per candidate. If B1 lands first, A2 must add `foundRoot` to whatever per-candidate record shape B1 introduces. Flag in the PR that these two touch the same two interfaces.
- **`FixGateResult.records` consumers** (`writeStagingManifest` land.ts:40, both CLI paths): all read named fields; the added optional field is non-breaking. Confirmed land.ts destructures explicitly.
- **Loop `memorize` stage re-derives `defects`** (optimize-loop.ts:137) — it must re-derive to match the `result.records` from the SAME round's fixGate. Since triage is deterministic and the run dir is the round's dir, the re-derived `defects` node set === the records node set. Low risk; guarded by the try/catch.
- **One-defect-per-node join** (triage.ts) is the correctness linchpin for `rootByNode`/`defectByNode` maps. If a future change made triage emit multiple defects per node, the map would collapse them — leave a code comment at the map construction pinning this assumption to triage.ts's one-iteration-per-score contract.
- **No new events required.** Optionally a `distilled` OptimizeEvent could be added later; NOT in scope (keep the change minimal; the stderr summary suffices).

## 8. Rollback / Safety

- Every new behavior is gated on `binding.distill` being present AND a lesson being `action:'append'`. A binding without `distill` ⇒ **identical to today** (placeholders remain). Removing the two call-site blocks + the two type fields fully reverts.
- Distillation runs inside the existing off-critical-path try/catch on both call sites; a distiller throw/timeout logs to stderr and is swallowed. `distillLesson` itself never throws on a bad distiller (distill.ts:97-98).
- Commit boundaries (git discipline): (1) driver.ts + land.ts type thread + core test; (2) optimize-fix.ts `distillAppendedLessons` + binding field + `--fix` wire + CLI test; (3) optimize-loop.ts wire. Three coherent commits, each building+green.

## 9. Open Questions

- **binding.distill vs. reuse binding.fixer's model:** recommended default = a SEPARATE optional `distill` export (a small distiller prompt is cheaper and differently-shaped than the fixer). Stated as recommended; user may prefer folding distillation into the fixer's return (`CandidateEdit.foundRoot` already exists) and skipping a second model call — but that conflates "propose a fix" with "write a durable lesson." Default: separate injected distiller.
- **Distill on `update` too?** Recommended default = NO (updates are materialize-only by design; re-distilling churns curated prose). If the user wants updates re-distilled when their Root is still `(pending`, that is a follow-up (detect placeholder-still-present before distilling an update). Not in scope.
- **Surface `foundRoot` on the staging manifest?** Recommended default = YES (durable, non-breaking, human-useful even without a distiller). Trivial to drop if unwanted.
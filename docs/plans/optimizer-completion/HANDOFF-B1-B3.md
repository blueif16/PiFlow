# HANDOFF — continue the optimizer B-cluster: B1 (Pareto) + B3 (redesign + `--generations`)

You are picking up the piflow optimizer ("the overlord"). The **A-cluster (6 loop-tail wire-ups) is DONE and
merged** — your job is the two next big rocks: **B1 multi-candidate Pareto at FIX+GATE** and **B3 the
long-horizon redesign subgraph + `--generations` CLI**. Read this whole doc, then the two plan files it points
to; they are the executable spec. Do NOT re-plan from scratch.

---

## 0. Mission in one paragraph

The overlord today is a **single-incumbent strict-improvement ratchet**: one fix candidate per defect, accept
iff its scalar strictly beats the incumbent, everything else discarded. **B1** turns FIX+GATE into *N
candidates + a Pareto front over a held-out slice-vector + a system-aware merge seam* — so a candidate that's
worse-on-average but better on a hard task slice is RETAINED instead of thrown away — **without ever loosening
auto-land**. **B3** wires the already-built-but-uncalled `runLongHorizon` outer loop into the CLI so
`optimize --generations N` runs N generations of (inner loop → an injected redesign subgraph authors the next
workflow's template → continue on it) — the self-designing-substrate seam. Both keep core model-free; all
intelligence is injected product-side.

## 1. State now (verified, do not re-derive)

- **Branch:** `feat/optimize-loop-tail-wiring`, pushed to origin. It is `main` + the 6 A-cluster commits +
  a `Merge branch 'main'` commit (reconciled; the only conflict was an append-only `packages/cli/src/index.ts`
  export list, resolved as a union). **Full suite 1593 passed / 7 skipped, `tsc -b` exit 0, `understand
  --check` exit 0.** The final `main` advance is a clean fast-forward, to be run from the PRIMARY checkout
  (`/Users/tk/Desktop/piflow`), NOT this worktree — this worktree cannot check out `main` (it's checked out
  there). `cd` into the primary checkout is normally disallowed for the agent; if `main` isn't advanced yet,
  either open/merge the PR or ask the user to `git checkout main && git merge --ff-only
  feat/optimize-loop-tail-wiring`.
- **The A-cluster you build on (all committed):**
  - A2 `fefa626` — `CandidateEdit.foundRoot?` + `FixGateRecord.foundRoot?` + `ManifestRecord.foundRoot?`
    (additive, conditional-spread); `distillLesson` wired into MEMORIZE; `OptimizeBinding.distill?` added.
  - A1 `4376c2b` — `FixGateRecord.liveRoot: string` (REQUIRED) + `FixGateStages.liveRootFor?` +
    `OptimizeBinding.liveRootFor?`; core `adoptFromManifest` (symlink-safe, idempotent) + the
    `optimize --adopt <manifest>` verb (the explicit out-of-loop physical land).
  - A6 `8517442` — `makeDefaultFixCyclesPort` + `OptimizeBinding.readFixCycles?/bumpFixCycles?` wired through
    `makeFixGateRunner` (binding's own port wins; else a CLI default under `--fix-cycle-ceiling`).
  - A4 `ed89b62` — `memory find|check` verbs; `defaultRunGate` now EXPORTED from `understand.ts`.
  - A3 `89036c4` — `memory compact` verb + `codeShifted`/`graduated` retire injectors.
  - A5 `b11a8e1` — OKF card anchors refreshed.
- **⚠️ The plan docs predate the A-cluster.** Where B1-pareto.md says "coordinate with A2 / land A2 first" and
  B3-redesign.md says "coordinate `OptimizeBinding` with A2's distiller" — **those are already resolved**: A2
  and A1 are committed, so you simply REBASE onto the committed shapes below. This is the single most important
  update the plan files don't have.

### The committed shapes B1/B3 rebase onto (read the real code — these are the anchors)

- `packages/core/src/optimize/driver.ts`:
  - `CandidateEdit` (≈:18) already has `foundRoot?`, `aborted?`.
  - `FixGateRecord` (≈:106) already has `candidateRef`, **`liveRoot: string` (required)**, `editsApplied`,
    `verdict`, `landed: 'adopted'|'staged'|'discarded'`, `tokensSpent`, `foundRoot?`.
  - `FixGateStages` (≈:61) already has `fixer`, `replayScore`, `prepareCandidate`, `baseScore`, `liveRootFor?`,
    `readFixCycles?`, `bumpFixCycles?`.
  - `runFixGate` is at **:154** (the single `for (const d of defects)` inner loop B1 makes N-candidate).
- `packages/cli/src/optimize-fix.ts` `OptimizeBinding` (≈:20) already has `oracle`, `copyScope`, `fixer`,
  `distill?`, `run?`, `mineOpts?`, `readFixCycles?`, `bumpFixCycles?`, `liveRootFor?`. **B3 adds `redesign?`
  ALONGSIDE these (no conflict now).**
- `packages/core/src/optimize/land.ts` already has `adoptFromManifest` + `ManifestRecord.{liveRoot, foundRoot}`.
  **B1's `front[]` on `ManifestRecord` coexists; the chosen winner's `candidateRef`+`liveRoot` is what
  `optimize --adopt` (A1) later replays** — so B1's winner-selection feeds A1's landing path. `adoptFile`/
  `adoptFromManifest` stay single-winner; the front is staged-only, never adopted.

## 2. B1 — multi-candidate Pareto (design in a nutshell)

**Full spec: `docs/plans/optimizer-completion/B1-pareto.md`.** The essence:

- **Governance split (the load-bearing invariant):** *strict-improvement still governs AUTO-LAND; Pareto
  governs what is RETAINED.* The Pareto front NEVER auto-lands anything — auto-land still requires
  `evaluateGate(...).accept` (strict scalar improvement, `gate.ts` UNCHANGED) + `landPolicy ===
  'auto-adopt-eligible'` + `opts.autoAdopt`. The front is a *retention* structure the human / next round /
  merge stage picks from; its members are `landed:'front'` (a NEW landed value), staged, never adopted.
- **Four pieces:**
  1. **`packages/core/src/optimize/pareto.ts` (NEW, pure)** — `dominates(a,b)` (strict Pareto dominance;
     `null` slice = incomparable, honoring "abstain ≠ 0") + `updateFront(front, candidate)`. This is the pure
     keystone; write its test first.
  2. **N-candidate inner loop** (`driver.ts:154`+) — up to `opts.candidatesPerDefect` (default **1** =
     byte-identical to today) attempts per defect, each `prepareCandidate → fixer → replayScoreVec → gate →
     updateFront`; then decide the winner (max aggregate scalar among gate-accepted) + retain the rest.
  3. **Set-valued types** — `FixGateRecord` gains `front: FrontMember[]`; keep the top-level fields as the
     WINNER's projection so every existing consumer stays working (a SUPERSET, non-breaking). Add optional
     `ReplayScoreVec`/`BaseScoreVec`/`MergeStage` to `FixGateStages`; when absent, degrade to the scalar
     `replayScore` and the front collapses to a 1-vector (== today's ratchet).
  4. **Slice-vector source (Q1, decided → per-check fold):** derive the score VECTOR from the per-check
     `checks[]` array already inside ONE verify report (`Tier1Result.checks`, `readVerifyReport` in
     `replay.ts`), so no extra oracle calls and no product change. The aggregate `scalar` the strict gate reads
     stays the existing fold → `gate.ts` untouched.
- **The load-bearing test** (`optimize-pareto.test.ts` + a driver test): candidate A scalar 0.6 slices
  `[0.6,0.5]`, candidate B scalar 0.4 slices `[0.2,0.9]` (better on the hard slice, worse on aggregate).
  Assert A is `landed:'adopted'`, B is retained `landed:'front'`, and NO front member with a
  non-strict-improving scalar is ever `'adopted'`. Test-the-test: wiring auto-land off the front (adopt B)
  must flip it red.
- **Top over-hardcoding trap:** `copyScope` MUST yield a fresh dir per call (N candidates need N distinct
  refs); the driver keys the front by `candidateRef` and treats a duplicate as "no new candidate." The test
  fixture returns a constant `cand:${node}` — do NOT assume distinctness.

## 3. B3 — long-horizon redesign subgraph + `--generations` (design in a nutshell)

**Full spec: `docs/plans/optimizer-completion/B3-redesign.md`.** The essence:

- **Two deliverables.** (a) The CLI WIRE (in this repo, now): add `redesign?: RedesignStage` to
  `OptimizeBinding`; parse `--generations N`; refactor `runOptimizeLoopCli` to extract a `runGeneration(gen,
  dir)` closure and compose the already-built `runLongHorizon({ runGeneration, redesign: binding.redesign },
  { templateDir, maxGenerations })` when `generations > 1`; print the generation trajectory. (b) The
  PRODUCT-SIDE redesign subgraph (a `claude -p` agent that reads a generation's run history + `loopResult`,
  then STAMPS the next workflow's template via the blueprints layer, returning `{ done, nextTemplate,
  rationale }`) — **design doc now, implementation deferred to the game-omni repo post-sign-off.**
- **Core is already done.** `runLongHorizon` + the long-horizon types are BUILT, TESTED, and EXPORTED
  (`packages/core/src/optimize/long-horizon.ts:84`; exports at `optimize/index.ts:50` + root `index.ts:408`).
  **If your CLI wire needs ANY core change, that's a red flag — STOP.** The wire is purely additive CLI.
- **Back-compat is a hard floor:** `--generations` absent (or `1`) must be byte-identical to today — the
  existing 3 `optimize-loop-cli` tests pass unchanged. A binding with NO `redesign` export + `--generations N`
  runs exactly ONE generation and honestly reports `no-redesign-seam`.
- **Load-bearing test** (`optimize-loop-cli.test.ts` + a `fake-loop-redesign-binding.mjs` fixture): a fake
  `redesign` returns `{done:false, nextTemplate:'<dir>::gen2'}` for gen 1 then `{done:true}` for gen 2; assert
  the output names both generations, the stop reason is `converged` (proving `done` threaded through
  `runLongHorizon`), and gen 2 optimized the `::gen2` template (proving `nextTemplate` threaded). Test-the-test:
  bypassing `runLongHorizon` (looping `runGeneration` on the seed dir) must flip assertions 2+3 red.

## 4. Decisions already made (the user chose "proceed on recommended defaults")

Build on these defaults — they are settled, not open:
- **B1-Q1 slice-vector source** → **per-check `checks[]` fold** (cheap, no oracle-count multiply, no product
  change). Escalate to a multi-task VAL vector only if per-check dims prove too correlated to form a real front.
- **B1-Q2 merge** → **ship the injected `MergeStage` SEAM** (typed + gated + stub-tested) now; DEFER the live
  merge fixer to the game-omni binding.
- **B1-Q3 default `candidatesPerDefect`** → **1** (byte-identical back-compat; `--candidates N` opts in).
- **B1-Q4 new front OptimizeEvents** → **defer** (manifest already records the front durably; events are polish
  and the render switch is exhaustive).
- **B3 redesign authority** → **bounded blueprint-STAMP gated by `piflowctl extract` exiting 0, never
  overwriting the incumbent template** (the loop-never-mutates invariant lifted to the outer loop) — NOT
  free-form DAG synthesis.
- **B3 seed templateDir threading** → for the wire + fake-binding test, a placeholder seed string suffices;
  the real "product `run` keys off the generation's template" wiring is the redesign author's concern (called
  out in the design doc). See §5.

## 5. Sign-off gates still needing a HUMAN before the PRODUCT-SIDE pieces land

The CLI/core wires above can proceed on the defaults. These are the human-decision points before the
game-omni implementations:
- **B3 self-design authority** (positioning): confirm "bounded blueprint stamp, extract-gated, never overwrite
  incumbent" is the accepted envelope before authoring the game-omni `redesign` export.
- **B3 `run(round)` → generation template**: the existing `binding.run(round)` reads its workflow from
  env/cwd; multi-generation optimizing W→W' needs `run` to key off the generation's template (env var or
  `--template` positional). A product decision.
- **B4 (NOT in scope here, but the sibling rock): the fixer binding lives in the game-omni product repo
  (`/Users/tk/Desktop/game-omni/packages/verify/optimize/binding-live.mjs`), NEVER vendored into SDK
  `packages/`.** B1's merge fixer + B3's redesign subgraph are authored in that SAME product binding. If you
  don't have the game-omni repo, you can ONLY do the SDK-side seams + tests here; HALT at the product code.

## 6. Sequencing + shared-file coordination

- **Do B1 first, then B3.** They share `packages/cli/src/optimize-fix.ts` (OptimizeBinding),
  `optimize-loop.ts` (the loop CLI composition), and `cli.ts` (help/dispatch). B1 touches driver/pareto/replay/
  land/events + the loop CLI; B3 touches the loop CLI + OptimizeBinding. Land B1's `optimize-loop.ts`
  composition first, then B3 rebases its `runGeneration`/`--generations` refactor onto it. (They do NOT
  otherwise share core files: B1 → pareto/driver/replay/land/events; B3 → CLI + docs only.)
- **Commit boundaries** (never a mega-commit): B1 = (1) `pareto.ts` + its test; (2) driver type block +
  N-loop + winner/land; (3) replay vector + land front[] + CLI `--candidates`. B3 = (1) `redesign?` +
  `--generations` parse + parse tests; (2) `runGeneration` refactor + `runLongHorizon` compose + dispatch +
  the load-bearing test; (3) the design doc `docs/design/long-horizon-redesign.md`.
- **Verify each on the diff, not the agent's report** (the A-cluster proved this matters — A1 shipped
  green-but-incomplete). Gate: `pnpm exec vitest run --project default packages/core/test packages/cli/test`
  + `pnpm -w exec tsc -b`. Keep the ≥1593 baseline green.

## 7. References (read these; do not restate them)

**Plan docs (the executable spec — START HERE):**
- `docs/plans/optimizer-completion/B1-pareto.md` — B1 full plan (design, change-set, test-first, self-check).
- `docs/plans/optimizer-completion/B3-redesign.md` — B3 full plan (steps 0–8, test-the-test, open Qs).
- `docs/plans/optimizer-completion/README.md` — master sequencing + the shared-file map for all 10 tasks.

**Research / spec (the "why"):**
- `docs/research/memory/eval-codex-goalmode-loop-patterns-2026-06.md` §4 — GEPA / AlphaEvolve; the Pareto
  rationale (the scalar ratchet IS the documented greedy-optimizer failure mode). **B1's north star.**
- `docs/research/memory/piflow-memory-v1.5.md` §6 (overlord) + the reconcile blocks — the long-horizon /
  redesign seam and the whole optimizer contract. **B3's north star.**
- `docs/research/memory/skillopt-sleep-loop-control-2026-06-29.md` §7 — thin-driver / injected-stage
  invariants (both rocks must honor these).

**Code entry points:**
- B1: `packages/core/src/optimize/{driver.ts:154 (runFixGate), gate.ts:58 (accept), replay.ts (readVerifyReport
  / makeReplayStages), land.ts (adoptFromManifest, ManifestRecord), events.ts, index.ts}` + NEW `pareto.ts`;
  CLI `packages/cli/src/optimize-fix.ts` (`--candidates`, merge/vec stages from binding).
- B3: `packages/core/src/optimize/long-horizon.ts:84 (runLongHorizon — DO NOT edit)`; CLI
  `packages/cli/src/{optimize-loop.ts (parse + runGeneration + compose), optimize-fix.ts (redesign? on
  OptimizeBinding), cli.ts:269 (dispatch — add `--generations` to the loop-CLI branch)}`.
- Product-side (deferred, game-omni repo): `packages/verify/optimize/binding-live.mjs` (the `claude -p` fixer
  the merge + redesign subgraphs mirror; model via `resolveFixerModel` deep tier — never hard-code a model).

**Memory (background context — verify before relying):**
- `[[piflow-optimize-layer-built]]` — the whole optimize layer + the A-cluster addendum (what's built).
- `[[piflow-memory-system-v1]]`, `[[memory-legs-coordination]]`, `[[blueprints-layer]]`,
  `[[game-omni-reference-product]]`, `[[optimize-loop-native-not-adhoc]]` (operational CLI, not ad-hoc bash),
  `[[claude-code-executor]]` (the fixer/redesign = Claude Code `claude -p`, not pi).

**Skills to load:** `test-discipline` (test-first, before ANY test), `agentic-prompt-design` (before writing
the redesign design doc / any injected-stage prompt), `piflow-enhance` (the optimize method), `okf-slices` +
`memory-slices` (the two legs).

## 8. The invariants both rocks must not violate (self-check)

- **Model PROPOSES + SCORES; deterministic code DECIDES / BOUNDS / LANDS.** B1's front comparator + gate are
  pure core; N candidates, slice scores, and merge are injected. B3's outer driver only SEQUENCES; the
  redesign intelligence is injected. Core gains NO model/network/prompt.
- **The loop never mutates a live file.** B1's front is in-memory records + candidate COPY refs; `adoptFile`
  stays the only physical writer, single-file, backed-up, driven only by the out-of-loop `--adopt`. B3's
  redesign authors a NEW template dir, never edits the incumbent.
- **Auto-land safety is unchanged.** `evaluateGate` (strict scalar improvement) is the ONLY auto-adopt gate;
  Pareto is retention-only. Prove it with the load-bearing test.
- **SDK boundary law.** `pareto.ts` is pure logic; `redesign?`/merge ride the CLI binding; the game-omni
  `claude -p` code stays in the game-omni repo, never in SDK `packages/`.
- **Test-first + mutation-verified + no over-hardcoding.** Both load-bearing tests assert OBSERVABLE decisions
  (which ref landed; which template each generation optimized) and have concrete test-the-test mutations.

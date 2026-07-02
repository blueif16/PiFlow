# A5-understand — Refresh drifted OKF anchors for the new optimize files (chore)

- **Cluster:** A-loop-tail
- **Effort:** small
- **Needs sign-off:** no
- **Depends on:** A2-distiller, B1-pareto
- **Shared-file risks:** —
- **Files touched:** /.agents/okf/topics/optimize.md · /.agents/okf/topics/memory-leg.md

**Open questions:**
- Should A5 be sequenced AFTER A2-distiller/B1-pareto (they shift driver.ts line numbers, re-drifting the safeEmit/runFixGate anchors) or run independently and accept a cheap idempotent re-run? Recommended default: run A5 LAST in the A-loop-tail cluster so the driver.ts anchors are authored against the final line numbers.
- Should the executor sync a local codegraph index in this worktree before --check so branch-1 line-drift detection is live (making the gate meaningfully catch the drift), or accept the inFile-fallback advisory-only mode + a manual grep oracle? Recommended default: sync codegraph if cheap; otherwise use the manual before/after grep oracle in Step 6 — the chore's correctness does not depend on it.

---
## A5-understand — Refresh drifted OKF anchors for the new optimize files (chore)

### 1. Goal / one-sentence outcome
Bring the two OKF code-map cards (`.agents/okf/topics/optimize.md`, `.agents/okf/topics/memory-leg.md`) back into honesty after the 2026-07-01 loop/distill/compact/long-horizon/memorize/recurrence files landed: re-author the 5 drifted `path:line — symbol` anchors to their TRUE current line, add the new `optimize/*.ts` files to `optimize.md`'s `seeds`/`symbols` so they get coverage in the arc + anchor derivations, correct the stale `memory-leg.md` DRIFT NOTE about the removed `index.ts` STUB label, then `--rebuild`/`--write` and confirm `piflowctl understand --check optimize memory-leg` exits 0. This is a DOC-card maintenance chore over the `.agents/okf` cards — NOT a code feature (no code, no unit tests, no build). The "test" is the gate exit code + a before/after anchor diff.

### 2. Why / invariants honored
- **SDK boundary law**: this chore touches ONLY `.agents/okf/topics/*.md` (repo-local doc cards) and shells the repo-local, zero-dependency `_generate.mjs` engine via `piflowctl understand`. No `@piflow/core` change, no model call, no network — the cards are product/repo-local reference, exactly where the CLAUDE.md data-boundary rule wants them.
- **Pointer + resolve-at-read**: the two-leg join is a single `[[okf-slice]]` cross-reference resolved at fix time (`enrichCodeMap` → `resolveSlice`). This chore keeps the ANCHOR to `enrichCodeMap` truthful in BOTH cards so that pointer stays followable; it does not embed any copy.
- **Model proposes / code decides**: the anchor re-authoring is a purely mechanical, deterministic doc edit; the `_generate.mjs` gate is the deterministic decider (exit 0/1). No intelligence is added.
- The optimizer LOOP never mutates a live source file — this chore is entirely out-of-loop and edits only doc cards, so it trivially cannot violate that.

### 3. Grounding — verified current state (READ this run)
The FACTS in the task were confirmed against the tree. Exact drift (card line → wrong anchor → TRUE current line:symbol):

**`.agents/okf/topics/optimize.md`** (`resource: packages/core/src/optimize/driver.ts`):
| card line | anchor as written (WRONG) | true current | note |
|---|---|---|---|
| 41 | `packages/core/src/optimize/triage.ts:35` — `triage` | `triage.ts:40` | line 35 is now `const tier1Failed = …`; `export function triage` is at line **40** |
| 60 | `packages/core/src/optimize/driver.ts:97` — `safeEmit` | `driver.ts:140` | line 97 is inside the `FixCycleSkip` block; `const safeEmit: OptimizeEventSink =` is at line **140** |
| 54 | `packages/cli/src/optimize-fix.ts:96` — `runOptimizeFixCli` | `optimize-fix.ts:193` | line 96 is a binding-validation `for (const k …)`; `export async function runOptimizeFixCli` is at **193** |
| 55 | `packages/cli/src/optimize-fix.ts:104` — `enrichCodeMap` | `optimize-fix.ts:108` | line 104 is inside the docblock; `export function enrichCodeMap` is at **108** |

`runFixGate` (card line 46, `driver.ts:124`) is CORRECT — verified `export async function runFixGate` is at line 124; do NOT touch it.

**`.agents/okf/topics/memory-leg.md`** (`resource: packages/core/src/memory/skeleton.ts`):
| card line | anchor as written (WRONG) | true current | note |
|---|---|---|---|
| 49 | `packages/cli/src/optimize-fix.ts:143` — `enrichCodeMap` | `optimize-fix.ts:108` | line 143 is now inside `scoreTriageEnrich`; the `enrichCodeMap` DEFINITION moved to line **108** |

Also verified CORRECT in memory-leg.md (do NOT touch): `understand.ts:136 resolveSlice` (line 136 ✓), `recurrence.ts:49 deriveRecurrence` (line 49 ✓), and the memory/skeleton/seed anchors at lines 38-45 (out of scope for the optimize refactor).

**Stale DRIFT NOTE — memory-leg.md line 52** self-flags: *"`index.ts` is marked `// STUB — RED phase` though the facade is wired…verify that label."* Verified: `packages/core/src/optimize/index.ts` head no longer contains "STUB — RED phase" — the facade is fully wired and re-exports the loop/distill/compact/memorize surface. So that self-flag is now RESOLVED and the sentence must be updated (say the STUB label is GONE / facade complete), not left asking to "verify."

**New `optimize/*.ts` files present but ABSENT from `optimize.md` seeds/symbols** (confirmed via `ls packages/core/src/optimize/`): `loop.ts`, `compact.ts`, `distill.ts`, `long-horizon.ts`, `memorize.ts`, `recurrence.ts`. (`recurrence.ts` IS anchored in memory-leg.md but is not in `optimize.md`'s seeds.) Current `optimize.md` seeds (line 8) list only score/triage/gate/driver/replay/mine/land/tier1/render/events/types + cli/optimize-fix — the six new files are missing.

**Public symbols for the new files** (for the `symbols:`/`aliases:` list, feeds `deriveAnchors`): `runOptimizeLoop` (loop.ts:80), `compactMemory` (compact.ts:67), `fillLessonProse`/`distillLesson` (distill.ts:58/87), `runLongHorizon` (long-horizon.ts — the redesign seam), `memorize` (memorize.ts:61), `deriveRecurrence`/`signatureOf` (recurrence.ts:49/31).

### 4. Gate mechanics (what actually blocks — the decider)
`_generate.mjs --check` (mode logic at line 36; exit at lines 319-323) blocks (exit 1) ONLY on a HEALTH failure. HEALTH = (a) every `seeds:` file exists (line 161), and (b) every structured anchor `` `path:line` — `symbol` `` resolves (healthCheck lines 163-191). Auto-region staleness (arc/file-table/lessons regenerable) is ADVISORY (comment lines 320-321), not blocking.

The anchor check has three branches:
1. **Def-anchor line ∈ codegraph span** (lines 173-184) — fires ONLY when `cgFind(token)` returns nodes for this file with `startLine`. **This worktree has NO local `.codegraph` index** (verified: `codegraph` binary is on PATH but there is no `.codegraph/` dir and `OKF_NO_CODEGRAPH` is unset). With no index, `cgFind` returns null/empty → branch (1) never fires → line-drift is NOT caught here today.
2. **`inFile` fallback** (line 186): the symbol token is still present *somewhere* in the cited file → PASS. All four/five drifted symbols (`triage`, `safeEmit`, `runOptimizeFixCli`, `enrichCodeMap`) still appear in their files → they PASS today. So the drift is currently ADVISORY, not blocking.
3. moved/deleted (lines 187-190) → the only path that would block, and none of these apply.

CONSEQUENCE: this chore is a HONESTY/quality refresh, not a broken-gate repair — `--check` likely already exits 0. The value is that the anchors will read TRUE (so a future executor/fixer who jumps to `triage.ts:35` lands on the right symbol), AND the cards become drift-gate-correct the moment a codegraph index is present (branch 1 would then flag them). Adding the six new files to `seeds` is SAFE because they all EXIST (a seed to a missing file WOULD block — do not add a path that doesn't exist).

### 5. Step-by-step execution (the chore)
All commands use the canonical `piflowctl understand` verb (NEVER `node …/_generate.mjs` directly, NEVER ad-hoc bash — honors the "operational capability lives in the SDK CLI" law). Run from the repo root `/Users/tk/Desktop/piflow/.claude/worktrees/memory-leg-a-wire`.

**Step 0 — branch.** This is a chore; create a short-lived branch: `chore/refresh-okf-optimize-anchors` (per the git-workflow rule; do not commit on the current feature branch's tip without a boundary). If already on a suitable worktree branch for the memory-leg-a-wire slice, the executor may stay — decide by whether other A-loop-tail cards are landing on the same branch.

**Step 1 — capture BEFORE state (the test baseline).**
- Run `piflowctl understand --check optimize memory-leg` and record the exit code + any `DRIFT`/`HEALTH` lines. (Expected today: exit 0, advisory drift only — because of the no-codegraph `inFile` fallback. If codegraph is synced first, expect the 5 line-drift advisories to appear.)
- OPTIONAL but recommended to make the check MEANINGFUL (§7): run `codegraph sync` (or the project's index-build) in this worktree FIRST so branch (1) is live and the gate can actually SEE the line-drift. Then re-run `--check` and confirm it now REPORTS the 5 drifts. This is the "test-the-test" for a doc chore: prove the gate can distinguish wrong anchors from right ones before you fix them. If codegraph cannot be synced here, fall back to the manual before/after `grep -n` anchor check in Step 6.

**Step 2 — re-author the 4 drifted anchors in `optimize.md`.** Edit ONLY the line numbers in these four anchor lines (keep the symbol text and the em-dash note verbatim):
- line 41: `triage.ts:35` → `triage.ts:40`
- line 60: `driver.ts:97` → `driver.ts:140`
- line 54: `optimize-fix.ts:96` → `optimize-fix.ts:193`
- line 55: `optimize-fix.ts:104` → `optimize-fix.ts:108`

**Step 3 — add the 6 new files to `optimize.md` frontmatter for coverage.**
- `seeds:` (line 8): append `packages/core/src/optimize/loop.ts, packages/core/src/optimize/compact.ts, packages/core/src/optimize/distill.ts, packages/core/src/optimize/memorize.ts, packages/core/src/optimize/recurrence.ts, packages/core/src/optimize/long-horizon.ts`. (Confirm each path EXISTS before adding — all six do; a missing seed BLOCKS.)
- `symbols:` (line 9): append `runOptimizeLoop, compactMemory, fillLessonProse, distillLesson, memorize, deriveRecurrence, runLongHorizon` (feeds `deriveAnchors`; harmless if codegraph is off).
- OPTIONAL: mirror the same symbol names into `aliases:` (line 7) so the FIND ranker routes queries like "optimize loop" / "compact memory" / "distill lesson" to this card.
- Add NEW anchor lines under the appropriate `# Anchors` section headers so each new file is dereferenceable (mechanical, symbol-accurate — verify each line with `grep -n`): e.g. a `LOOP` group with `loop.ts:80 — runOptimizeLoop`, a `COMPACT` group with `compact.ts:67 — compactMemory`, a `DISTILL` group with `distill.ts:58 — fillLessonProse` + `distill.ts:87 — distillLesson`, `memorize.ts:61 — memorize`, `long-horizon.ts:<runLongHorizon line>` (grep it), and note `recurrence.ts:49 — deriveRecurrence` (already anchored in memory-leg; a cross-reference note is enough). Keep the curated prose in `# Why / how it works` accurate if you add a sentence describing the loop/compact/distill seam — but that prose is out of HEALTH scope, so keep it minimal and truthful.

**Step 4 — fix the memory-leg.md drift.**
- line 49: `optimize-fix.ts:143` → `optimize-fix.ts:108` (the `enrichCodeMap` definition).
- line 52 DRIFT NOTE: replace the trailing "`index.ts` is marked `// STUB — RED phase`…verify that label." with a resolved statement, e.g. "the `optimize/index.ts` facade is now fully wired (no STUB — RED label remains) and root-exports the loop/distill/compact/memorize surface." Keep the rest of the DEFERRED note (LLM-distilled root/prevention + cap/retire) as-is unless A2/A3 land first (see §9 couplings).

**Step 5 — rebuild the auto-regions and re-check.**
- Run `piflowctl understand --rebuild optimize memory-leg` (regenerates the `<!-- okf:auto-start -->…<!-- okf:auto-end -->` file-set table, arc, lessons, and — if codegraph is synced — the code-anchor blast section). This picks up the six new seeds in the arc + file table.
- Run `piflowctl understand --check optimize memory-leg` and CONFIRM exit 0 with NO `HEALTH` line. If codegraph was synced in Step 1, ALSO confirm the 5 previously-reported line-drift advisories are now GONE (this is the real proof the re-authoring landed on the right line).

**Step 6 — before/after anchor confirmation (if no codegraph).** For each re-authored anchor, confirm the cited line now carries the symbol: `grep -n "export function triage" packages/core/src/optimize/triage.ts` → line 40, etc. This is the manual oracle when the gate's branch-1 can't run.

**Step 7 — commit.** One commit, one idea: `chore(okf): refresh optimize/memory-leg anchors + seed the new loop/distill/compact/memorize/long-horizon files`. The gitignored `.agents/okf/topics/.gen-cache.json` (verified `git check-ignore` matches) must NOT be staged — confirm `git status` shows only the two `.md` cards. End the message with the Co-Authored-By trailer.

### 6. Test / verification plan (this is a doc chore — the gate IS the test)
There is no code and no unit test. The verification contract:
- **Load-bearing gate**: `piflowctl understand --check optimize memory-leg` exits 0 with no `HEALTH:` line (the deterministic decider, `_generate.mjs` lines 319-323).
- **Test-the-test (the mutation that proves the gate has teeth)**: BEFORE fixing, with a codegraph index present (Step 1 optional sync), run `--check` and confirm it REPORTS the line-drift for the 4+ wrong anchors (i.e. the gate distinguishes a wrong line from a right one). If it reports nothing even with the index, the gate is not exercising these anchors and the "green" is meaningless — STOP and investigate before editing. If codegraph cannot be synced in this worktree, substitute the manual mutation: temporarily set one anchor to a deliberately-nonexistent line/symbol token (e.g. `triage.ts:9999 — triageXXX`) and confirm `--check` fails (branch-2 `inFile` catches the bogus token), then revert — proving the check is live, not a no-op.
- **Before/after anchor oracle**: `grep -n` each re-authored symbol resolves to the cited line (Step 6).
- **Full confirmation requires RUNNING the gate** — the executor performs Steps 1/5/6; this plan does not run it (scope fence).
- **Explicitly NOT done**: no `npm run build`, no vitest, no core/CLI change — the `.md` cards are not compiled and the gate is self-contained.

### 7. Risks / gotchas
- **The gate may already be green** (no local codegraph index → `inFile` fallback passes the drifted anchors). Do NOT interpret a green `--check` before editing as "nothing to do" — the anchors are still WRONG for a human/fixer reader and will block the moment an index exists. The chore's value is honesty + future-proofing; verify via the manual before/after grep, not only the exit code.
- **A missing seed BLOCKS**: only add `seeds:` paths that exist (all six new files verified present). Typo a path and `--check` fails on `seed missing:`.
- **`.gen-cache.json` churn**: regenerable + gitignored — never stage it.
- **Auto-region hand-edit**: never hand-edit between the `okf:auto-*` markers; let `--rebuild` own that region (the engine warns on this).
- **Coupling with A2/A3** (see §9): if A2-distiller adds a root-cause field to `CandidateEdit`/`FixGateResult` in `driver.ts` or A3-compact changes `compact.ts`, their line numbers shift and this card's `driver.ts:140 safeEmit` / new `compact.ts:67 compactMemory` anchors drift again. Land A5 AFTER A2/A3 if they are landing in the same cycle, or accept that A5 re-runs. The chore is cheap to repeat (it is idempotent: re-run `--check` → re-author → `--write`).

### 8. Definition of done
- `optimize.md`: 4 anchors re-authored to correct lines; 6 new files in `seeds` + their symbols in `symbols` (and optionally `aliases`) + a new anchor line per new file; curated prose still truthful.
- `memory-leg.md`: `enrichCodeMap` anchor → `optimize-fix.ts:108`; the `index.ts` STUB self-flag in the DRIFT NOTE resolved.
- `piflowctl understand --rebuild optimize memory-leg` run; `piflowctl understand --check optimize memory-leg` exits 0 with no HEALTH failure.
- One commit, only the two `.md` cards staged, cache not staged.

### 9. Cross-task couplings (flag, do not resolve here)
- **A2-distiller** and **B1-pareto** both edit types in `packages/core/src/optimize/driver.ts` (A2 adds a root-cause field to `CandidateEdit`/`FixGateResult`; B1 makes candidates set-valued). Either shifts `driver.ts` line numbers → re-drifts this card's `driver.ts:140 safeEmit` (and `driver.ts:124 runFixGate`) anchor. **Sequence A5 after A2/B1** in the same cycle, or expect a cheap re-run. Recorded in `dependsOn`.
- **A3-compact**'s `codeShifted` retire-trigger is fed by A5/understand `--check` output — A5 refreshing the anchors improves that signal; no code coupling, but flagged so A3 knows the anchors are fresh.
- No shared FILE edits with other tasks (A5 edits only `.md` cards; A2/B1 edit `driver.ts` source — different files), so `sharedFileRisks` is empty, but the LINE-NUMBER coupling above is the real risk.

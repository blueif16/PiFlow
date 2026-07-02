# B1-pareto — Multi-candidate Pareto at FIX+GATE

- **Cluster:** B-big-rock
- **Effort:** large
- **Needs sign-off:** YES
- **Depends on:** A2-distiller
- **Shared-file risks:** packages/core/src/optimize/driver.ts — A2-distiller also edits CandidateEdit/FixGateResult in this file (A2 adds foundRoot + a root-cause field; B1 makes FixGateRecord set-valued + adds vector/merge stages). Co-author the type block or land A2 first. · packages/core/src/optimize/land.ts — A1-land / B4-fixer also concern how files are landed; B1 keeps adoptFile single-file but the winner-selection call site must reconcile if they change adopt semantics.
- **Files touched:** packages/core/src/optimize/pareto.ts · packages/core/src/optimize/driver.ts · packages/core/src/optimize/replay.ts · packages/core/src/optimize/land.ts · packages/core/src/optimize/events.ts · packages/core/src/optimize/index.ts · packages/cli/src/optimize-fix.ts · packages/cli/src/optimize-loop.ts · packages/core/test/optimize-pareto.test.ts · packages/core/test/optimize-driver.test.ts · packages/core/test/optimize-land.test.ts · packages/core/test/optimize-replay.test.ts

**Open questions:**
- Q1 — Slice-vector source: fold the per-check `checks[]` array of ONE verify report into the ScoreVector (cheap, no extra oracle calls, no product change; RECOMMENDED DEFAULT), OR require the product to mine a multi-task VAL vector (N oracle calls per candidate, richer but costly and needs a product-binding change). Recommend the per-check fold for v1; escalate to multi-task only if per-check dimensions prove too correlated to form a real frontier.
- Q2 — Merge stage in v1 or deferred: ship the injected `MergeStage` seam now (thin, no core intelligence) but leave the actual merge fixer product-side/deferred, OR defer the whole merge seam to a follow-up and ship only the N-candidate front first. Recommend shipping the SEAM (typed + gated + tested with a stub) now so the front has an exploitation path, but deferring the live merge fixer to the game-omni binding.
- Q3 — Default candidatesPerDefect: keep default 1 (byte-identical back-compat, opt-in via --candidates N; RECOMMENDED) vs default >1. Recommend default 1 — Pareto is a cost multiplier and the strict ratchet is the safe baseline; the user opts into exploration explicitly.
- Q4 — New OptimizeEvents for front/retained candidates: add them now (requires new render cases in the exhaustive switch) or defer to keep the task tight. Recommend defer — the manifest already records the front durably; live events are additive polish.

---

# B1-pareto — Multi-candidate Pareto at FIX+GATE

## 1. Problem & Goal

The overlord is a **single-incumbent strict-improvement ratchet**. `runFixGate` (driver.ts:147) loops once per defect: one `prepareCandidate` → one `fixer` → one `replayScore` → one `evaluateGate` → one `landed` decision. The accept predicate (gate.ts:58) is `candidate > base` on a **single scalar** over one held-out VAL task. Everything that doesn't strictly beat the incumbent goes to the `rejectedBuffer` and is never seen again (driver.ts:194).

The §4 verdict of `docs/research/memory/eval-codex-goalmode-loop-patterns-2026-06.md` names this the single most important missing pattern: *"v1.5's gate predicate 'accept iff the scalar strictly improves' is, verbatim, the documented greedy-optimizer failure mode."* GEPA (P4) and AlphaEvolve (P5) both abandoned exactly this design because a scalar ratchet gets stuck in local optima and discards a candidate that is **worse-on-average but better on a hard task slice**. Their fix: keep a **Pareto front of candidates that win on different task subsets**, then **merge complementary ones** (GEPA's system-aware merge; AlphaEvolve's MAP-Elites/island database).

**Goal:** move FIX+GATE from single-incumbent to **N candidates per defect + a Pareto front over a held-out slice-vector + a system-aware merge seam**, WITHOUT loosening the auto-land safety.

## 2. The Governance Split (the load-bearing invariant this plan honors)

From the handoff, verbatim, and this is the spine of the whole design:

> **Strict-improvement still governs AUTO-LAND; Pareto governs what is RETAINED (the front over a held-out slice). Candidate GENERATION is the agent's job (injected); the front/merge is the THIN deterministic layer.**

This maps cleanly onto the existing "model PROPOSES + SCORES; deterministic code DECIDES/BOUNDS/LANDS" invariant:
- **Model (injected)** — proposes N candidate edits; scores each candidate on each slice of a slice-vector. Both live in the injected `fixer` / `replayScore` stages, product-side (game-omni's `claude -p` fixer + `runMilestoneVerify2` oracle). Core gains **no** model call.
- **Deterministic core** — (a) the Pareto **dominance comparator** + front maintenance (a NEW pure fn, keeps the front); (b) the UNCHANGED `evaluateGate` strict-improvement predicate on the aggregate scalar, which alone still decides `accept` and thus auto-land eligibility; (c) records the front + the auto-land winner into a set-valued manifest; (d) the merge is an **injected** stage the driver invokes with the front, and its output is re-gated exactly like any other candidate (no special path around the strict gate).

So: **the Pareto front NEVER auto-lands anything.** Auto-land still requires `evaluateGate(...).accept === true` (strict scalar improvement) AND `landPolicy === 'auto-adopt-eligible'` AND `opts.autoAdopt`. The front is a **retention** structure — the human (or the next round / the merge stage) picks from it; it is staged, never adopted, unless one of its members also strictly-improves the scalar and passes the existing gate. This is what keeps GEPA's exploration from ever violating the "loop never lands a regression" rule. It also honors the loop-never-mutates-a-live-file invariant: the front is entirely in-memory records + candidate COPY refs; `land.ts` still owns every physical mutation.

## 3. What "a slice" means here (a decision that shapes everything — see Open Questions)

Today `makeReplayStages` (replay.ts) mines **one** `CheckableTask` per node (`mineTask(node)`) and scores it to one scalar. A Pareto front needs a **vector** of scores over ≥2 held-out slices, else dominance collapses to the scalar and the front is trivially a single point (Pareto over a 1-vector == the scalar ratchet). So Pareto is only meaningful once the replay harness can score a candidate on a **slice-vector** (e.g. `gs01:M2`, `gs01:M3`, … — the several VAL milestones a node touches).

**Recommended default (see Open Q1):** keep the CHANGE to core/driver + gate + land minimal and slice-vector-READY, but source the vector from the *existing* per-check granularity already inside a single verify report. `readVerifyReport`/`Tier1Result` (types.ts:41) already carries a `checks: Tier1Check[]` array — a per-check pass/fail vector. The candidate's **slice-vector** = the per-check pass fractions (or per-gate fractions) from ONE oracle call, so we do NOT need N oracle calls per candidate (cost stays bounded) and we do NOT need product-side re-mining. The aggregate scalar the strict gate reads stays `r.scalar` (the existing fold), so gate.ts is untouched. This makes the front a real multi-dimensional object at near-zero added oracle cost and keeps the SDK-boundary law intact.

## 4. Design — the four pieces

### 4a. Core: the dominance comparator + front (NEW thin pure fn) — `packages/core/src/optimize/pareto.ts`

A NEW module (mirrors the "one concern per file" pattern: gate.ts is pure arithmetic; this is pure set logic). No model, no network, no disk — a pure function over score-vectors. Contract:

```ts
export type ScoreVector = (number | null)[];   // per-slice scalars aligned by index; null = abstained on that slice

/** a dominates b iff a >= b on EVERY measurable slice AND a > b on at least ONE (strict Pareto dominance).
 *  Abstain handling (honors "ABSTAIN ≠ low score", replay.ts): a null on either side for a slice makes that
 *  slice INCOMPARABLE — it neither helps nor blocks dominance (drop it from the comparison). If NO slice is
 *  mutually measurable, neither dominates (returns false both ways) so both are retained (conservative). */
export function dominates(a: ScoreVector, b: ScoreVector): boolean;

/** Insert `candidate` into `front`, dropping any incumbent it dominates and rejecting it if any incumbent
 *  dominates it (or it ties every incumbent — no new information). Returns the new front + whether it was kept.
 *  DETERMINISTIC + STABLE (no timestamp/random) so the manifest renders identical bytes for identical inputs. */
export function updateFront<T extends { scores: ScoreVector }>(front: T[], candidate: T): { front: T[]; kept: boolean };
```

Design notes bound to the spec:
- Strict Pareto dominance = GEPA's "excel on different task subsets" retention rule (§4/P4). A candidate worse-on-average but better on one hard slice is NOT dominated, so it is RETAINED — the exact thing the scalar ratchet threw away.
- Comparator honors the abstain invariant: a `null` slice is incomparable, never treated as 0 (replay.ts foldScore already yields null on abstain). This is load-bearing — treating null as 0 would let an abstained candidate falsely dominate.
- Ties: a candidate equal to a front member on every measurable slice adds no frontier information → not kept (bounds front size).

### 4b. Core: the N-candidate inner loop — `driver.ts:166-206`

Replace the single `prepareCandidate → fixer → replayScore → gate → land` body with an **inner N loop per defect**, controlled by a NEW `opts.candidatesPerDefect` (default **1** — so with no opt-in the behavior is byte-identical to today; this is the back-compat spine, same discipline as the fix-cycle-ceiling gate at driver.ts:132).

For each defect, up to N times (bounded by the SAME editBudget/tokenBudget checks, which stay per-ATTEMPT so N candidates consume N attempts — the cost bound is respected, GEPA's "35× fewer rollouts" is about front-quality not unbounded spend):
1. `candidateRef = await prepareCandidate(d)` — **must yield a distinct ref each call.** (See §6 Risk: the current `copyScope` fixture returns a fixed `cand:${node}` string; the real game-omni `copyScope` copies to a fresh dir so it is already per-call-distinct, but the driver must not ASSUME distinctness — it keys the front by candidateRef and asserts N distinct refs, else collapses to fewer candidates. Flag for the product binding.)
2. `edit = await fixer(d, { candidateRef, emit })` — same injected fixer; the fixer is told (via a NEW optional `attempt`/`priorSummaries` field on the ctx, see 4d) that this is candidate k so it can diversify (AlphaEvolve "seed with diverse high-performing programs"). Optional; a fixer that ignores it just produces correlated candidates and the front stays small — no correctness issue.
3. `scoreVector = await replayScoreVec(d.node, candidateRef)` — the NEW vector-valued scorer (4c). Its aggregate `scalar` (the existing single fold) is what the strict gate reads.
4. `verdict = evaluateGate({ ...unchanged..., candidate: aggregateScalar })` — **gate.ts is untouched**; the strict-improvement decision is per-candidate on the aggregate scalar exactly as today.
5. `updateFront(front, { candidateRef, edit, verdict, scores: scoreVector })`.

After the N inner attempts, DECIDE landing (driver.ts:190-207 logic) using the **front + the strict gate**:
- **auto-land winner** = the front member with `verdict.accept === true` AND `landPolicy === 'auto-adopt-eligible'` AND `opts.autoAdopt`, choosing the max aggregate-scalar among those (ties → first, deterministic). `landed='adopted'`. If none qualifies but ≥1 has `verdict.accept`, that best-scalar accepted one is `landed='staged'`. If none accepted, the whole front is `landed='discarded'` and the defect key enters `rejectedBuffer` (unchanged reject path; a real failed fix still bumps the fix-cycle counter — but only ONCE per defect, not once per candidate: bump iff the BEST candidate was rejected with ≥1 edit, preserving the driver.ts:197 semantics).
- **The rest of the front is RETAINED** (`landed='front'`, a NEW landed value) — staged into the manifest but not adopted. This is the retention the spec mandates.

Merge (system-aware, GEPA): AFTER building the front, if `opts.merge` (a NEW **injected** stage, 4d) is present AND the front has ≥2 members, call `merged = await merge(d, front.map(f => f.candidateRef))` → it returns a new candidateRef (a candidate that combines complementary front members, product-side — e.g. the fixer re-run told to compose two diffs). The merged candidate is then **scored + gated + front-inserted exactly like any other candidate** (no bypass of the strict gate — it can auto-land only if it strictly improves). This keeps the merge honest and inside the governance split.

### 4c. Core: set-valued types + the vector scorer (COORDINATE WITH A2 — see §5)

- `CandidateEdit` (driver.ts:18) — A2-distiller ADDS `foundRoot?: string` (the fixer's traced root, consumed by `distillLesson`'s `opts.foundRoot`). This plan does NOT need to change `CandidateEdit` itself, but it lands in the SAME interface A2 edits → coordinate the diff.
- `ReplayScore` (driver.ts:41) stays for back-compat; ADD `ReplayScoreVec = (node, candidateRef) => Promise<{ scalar: number|null; slices: ScoreVector }>` and inject it alongside (or the driver derives the vector from a richer return). Recommended: extend `makeReplayStages` (replay.ts) to also return `replayScoreVec`/`baseScoreVec` that fold `readVerifyReport(report).checks` into a per-check `ScoreVector` while keeping `scalar` = the existing fold. `baseScoreVec` gives the incumbent's slice-vector so dominance can be measured against the base too (the base is a front member at round start).
- `FixGateRecord` (driver.ts:86) — becomes set-valued: ADD `front: FrontMember[]` where `FrontMember = { candidateRef; editsApplied; tokensSpent; scores: ScoreVector; verdict: GateVerdict; landed: 'adopted'|'staged'|'front'|'discarded' }`. Keep the top-level `candidateRef`/`verdict`/`landed`/`editsApplied` as the **chosen winner's** (so every existing consumer — land.ts manifest, events, CLI summary — keeps working unchanged; back-compat by making the scalar fields the winner's projection of the set). This is the key to a non-breaking type change: the record is a SUPERSET.
- `FixGateResult` (driver.ts:108) — A2-distiller adds a root-cause field here too; this plan adds nothing at the result level beyond what flows through records. Coordinate the single edit.

### 4d. Injected stage types (all product-side; core stays product-agnostic)

- `Fixer` ctx (driver.ts:39): ADD optional `attempt?: number` and `priorSummaries?: string[]` so a fixer CAN diversify candidate k from candidates 1..k-1 (AlphaEvolve diversity seeding). Optional → a fixer ignoring it is 100% valid.
- NEW `MergeStage = (defect, frontRefs: string[]) => Promise<string>` (returns a candidate ref) — the system-aware merge, injected via `FixGateStages.merge?`. Absent → no merge step (default). Product-side (the merge intelligence is the agent's job).
- `ReplayScoreVec`/`BaseScoreVec` added to `FixGateStages` as OPTIONAL; when absent, the driver falls back to the scalar `replayScore`/`baseScore` and the front degenerates to a 1-vector (== today's ratchet). This is the graceful-degradation spine.

### 4e. Land / manifest retention — `land.ts:24-63`

`ManifestRecord` (land.ts:24) gains a `front: { candidateRef; landed; delta; scores }[]` array (the retained front, flattened deterministically like the existing verdict flattening). `writeStagingManifest` (land.ts:37) maps `r.front` into it. `adoptFile` (land.ts:78) is UNCHANGED — it adopts ONE file from the chosen winner's candidateRef; the front members are staged-as-record only, never adopted (honors "loop never mutates a live file" + "auto-land is strict-improvement only"). The manifest stays deterministic (no timestamp/random) so the front renders identical bytes for identical inputs (land.ts invariant).

## 5. Cross-task coordination

- **A2-distiller (SHARED FILE: driver.ts):** A2 adds `foundRoot` to `CandidateEdit` and a root-cause field to `FixGateResult`; B1 restructures `FixGateRecord` to set-valued + adds `ReplayScoreVec`/`MergeStage` to `FixGateStages`. BOTH edit the same interfaces in driver.ts (18, 86, 108, 47). **Land A2 FIRST or co-author the type block** so the merge is one coherent interface change, not two conflicting rewrites. B1 dependsOn A2 for the type-block ordering (not for logic — they are orthogonal in behavior; the coupling is purely the shared type file).
- **B4-fixer / A1-land (landing files):** B1 does NOT change `adoptFile`'s single-file semantics; the winner is one file. If B4/A1 change how files are landed (multi-file adopt), B1's "chosen winner → adoptFile" call site must be reconciled. Flag but no hard dependency.

## 6. Risks / gotchas

- **`copyScope` must be per-call-distinct.** The test fixture returns a constant `cand:${node}`; N candidates would collide. The driver must key the front by candidateRef and treat a duplicate ref as "the fixer produced no new candidate" (attempt still counts toward the budget). Document the product-binding contract: `copyScope` MUST yield a fresh dir per call. This is the top over-hardcoding trap — do NOT assume distinctness.
- **Front unboundedness:** cap the front (`opts.maxFront`, default = `candidatesPerDefect`) so a pathological all-incomparable batch can't blow memory; drop the lowest-aggregate-scalar incomparable member when over cap (a bounded MAP-Elites, AlphaEvolve). Deterministic tie-break.
- **Cost:** N candidates = N fixer calls + N oracle calls. Keep the slice-vector sourced from ONE oracle call per candidate (per-check fold, §3), so we do NOT multiply oracle cost by slice count. The editBudget/tokenBudget caps stay the hard ceiling.
- **Do NOT loosen the gate.** The single most dangerous mistake is letting a Pareto-retained (non-scalar-improving) candidate auto-land. Auto-land stays gated on `evaluateGate().accept` (strict scalar improvement). A test MUST prove a front member that is Pareto-non-dominated but scalar-non-improving is `landed='front'`/`'staged'`, NEVER `'adopted'`.

## 7. Test-first plan (test-discipline: a test must FAIL when the code is wrong)

Write tests BEFORE implementation. New/edited files:

**`packages/core/test/optimize-pareto.test.ts` (NEW) — the comparator (the pure keystone):**
- `dominates([0.9,0.2],[0.5,0.5])` → **false** (better on slice 0, WORSE on slice 1 → incomparable; this is the whole point — the ratchet would have discarded [0.5,0.5]).
- `dominates([0.9,0.9],[0.5,0.5])` → **true** (>= on all, > on one).
- `dominates([0.5,0.5],[0.5,0.5])` → **false** (tie is not strict dominance).
- abstain: `dominates([0.9,null],[0.5,0.5])` → dominance decided ONLY on slice 0 → true; `dominates([null,null],[0.5,0.5])` → false (no mutually-measurable slice).
- `updateFront`: inserting an incomparable candidate KEEPS both (front length grows); inserting a dominated candidate is rejected (kept=false, front unchanged); inserting a dominator drops the dominated incumbent.

**LOAD-BEARING test + its test-the-test mutation:**
> *"A Pareto-retained candidate that beats the incumbent on a hard slice but is worse on the aggregate scalar is RETAINED on the front but is NEVER auto-adopted; only the strict-scalar-improving candidate can auto-adopt."*

Concrete: two candidates for one FUNCTIONALITY defect, `autoAdopt: true`, `candidatesPerDefect: 2`. Candidate A: scalar 0.6 (> base 0.5), slices `[0.6,0.5]`. Candidate B: scalar 0.4 (< base 0.5) but slices `[0.2,0.9]` (better on the hard slice 1). Assert: `record.landed==='adopted'` and the adopted candidateRef is A's; `record.front` contains B with `landed==='front'`; and NO front member with `landed==='adopted'` has a non-strict-improving scalar.
> **Test-the-test mutation:** if the implementer wires auto-land off the Pareto front instead of off the strict gate (e.g. adopts the max-slice-1 candidate B), THIS TEST FAILS (B is scalar 0.4 ≤ base 0.5, must never adopt). If the implementer collapses the front to the scalar (drops B entirely), the `record.front contains B` assertion FAILS. Both wrong implementations are caught. The test asserts an OBSERVABLE decision (which ref landed), not intent.

**`packages/core/test/optimize-driver.test.ts` (EDIT):**
- Back-compat: with `candidatesPerDefect` unset (default 1) EVERY existing test still passes byte-identically (the record's top-level fields == the single winner). Do not modify existing cases; add a `describe('multi-candidate')` block.
- Budget: `candidatesPerDefect: 3, editBudget: 2` → only 2 candidates attempted (per-attempt budget respected), `stoppedReason: 'edit-budget'`.
- Merge: inject a `merge` stub returning a ref whose `replayScoreVec` strictly improves → it enters the front AND (with autoAdopt) can win; a `merge` returning a scalar-non-improving ref → staged/front, never adopted.
- Fix-cycle bump: a defect whose entire front is rejected with ≥1 edit bumps the counter EXACTLY once (not once per candidate).

**`packages/core/test/optimize-land.test.ts` (EDIT):** manifest carries `front[]`; `adoptFile` still adopts exactly one file (unchanged); deterministic bytes for identical set-valued input.

**`packages/core/test/optimize-replay.test.ts` (EDIT):** `replayScoreVec` folds `checks[]` into a `ScoreVector` while `scalar` matches the existing fold; abstained report → all-null vector + null scalar (abstain ≠ 0 across the vector).

Gate to green: `npx vitest run packages/core/test/optimize-*.test.ts` and the full `packages/core` suite (the driver/gate/land/replay contracts + the 1404 existing tests must stay green — back-compat is a hard requirement).

## 8. Files & sequencing (executor follows in order)

1. `packages/core/src/optimize/pareto.ts` (NEW) — write test first (`optimize-pareto.test.ts`), then `dominates`/`updateFront`.
2. Coordinate the driver.ts type block with A2 (land A2 or co-edit): set-valued `FixGateRecord`, `FrontMember`, optional `ReplayScoreVec`/`BaseScoreVec`/`MergeStage` on `FixGateStages`, `candidatesPerDefect`/`maxFront`/`merge` on `FixGateOpts`.
3. `driver.ts:166-206` — the N-candidate inner loop + front build + winner/land decision + merge invocation (default N=1 = byte-identical).
4. `replay.ts` — `replayScoreVec`/`baseScoreVec` (fold `checks[]`).
5. `land.ts:24-63` — `front[]` on the manifest record.
6. `events.ts` — OPTIONAL new events (`candidate-retained`, `front-built`); safe to defer (the render is exhaustive-switch, so any new event needs a case — either add cases or defer the events entirely to keep this task tight).
7. `packages/cli/src/optimize-fix.ts` + `optimize-loop.ts` — surface `--candidates N` and pass `merge`/vector stages from the binding when present; default off (single-candidate) so the shipped CLI behavior is unchanged until a user opts in.
8. Update `packages/core/src/optimize/index.ts` exports (`dominates`, `updateFront`, `ScoreVector`, `FrontMember`, `MergeStage`, `ReplayScoreVec`).

## 9. Why each choice honors an invariant (self-check trace)

- **Model proposes/scores, code decides/bounds/lands:** front comparator + gate are pure core; N candidates + slice scores + merge are all injected (fixer/replayScoreVec/merge). Core gains NO model/network/prompt.
- **Loop never mutates a live file:** the front is in-memory records + candidate COPY refs; `adoptFile` still owns the only physical write, still single-file, still backed-up.
- **Auto-land safety unchanged:** `evaluateGate` (strict scalar improvement) is the ONLY auto-adopt gate; Pareto is retention-only. Proven by the load-bearing test.
- **SDK boundary law:** `pareto.ts` is pure logic; the vector fold reuses `readVerifyReport`; product stages (merge, oracle vec) ride the CLI binding.
- **Pointer/resolve-at-read (memory legs):** untouched — this task is upstream of MEMORIZE; the front's chosen root still flows to A2's distiller via `foundRoot`.
- **Test-first + mutation-verified + no over-hardcoding:** the load-bearing test asserts WHICH ref landed (observable) and has a concrete mutation (adopt-off-the-front) that flips it red; back-compat suite stays green.

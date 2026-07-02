# B2-tier23 — Tier-2/3 hardened judgment (informs ranking, never gates)

- **Cluster:** B-big-rock
- **Effort:** large
- **Needs sign-off:** YES
- **Depends on:** A2-distiller, B1-pareto
- **Shared-file risks:** packages/core/src/optimize/types.ts also edited by A2-distiller (adds root-cause field to CandidateEdit/FixGateResult) and B1-pareto (makes candidates set-valued) — all three add sibling types/fields to the SAME file; coordinate insertion points, no logical conflict · packages/core/src/optimize/triage.ts — B1-pareto may also touch Defect ordering/shape; the judgment ranking channel reorders the worklist, so land order matters · packages/cli/src/optimize-fix.ts — B4-fixer also edits this file (landing/fixer wiring); the judge-enrichment insertion in scoreTriageEnrich must not collide with B4's fixer changes
- **Files touched:** packages/core/src/optimize/judgment.ts · packages/core/src/optimize/types.ts · packages/core/src/optimize/score.ts · packages/core/src/optimize/triage.ts · packages/core/src/optimize/index.ts · packages/core/test/optimize-judgment.test.ts · packages/core/test/optimize-triage-judgment.test.ts · packages/core/test/optimize-score-judgment-quarantine.test.ts · packages/cli/src/optimize-judge.ts · packages/cli/src/optimize-fix.ts

**Open questions:**
- Where does game-omni's per-node GOLDEN SAMPLE live and how is it keyed to a node? The pairwise ranker needs candidate-vs-golden, and the golden is PRODUCT-side (SDK boundary law). Recommended default: the judge binding (product-side) owns golden resolution entirely — core's JudgePairwise receives already-resolved {candidate, golden} artifact refs and knows nothing about where a golden lives; if game-omni has no golden for a node, the judge returns null and the node simply carries no judgment signal.
- Should the Tier-2 judgment run in the DEFAULT optimize path (every --fix / --rounds run) or only behind an explicit opt-in (a --judge flag / a binding that exports a judge)? Recommended default: OPT-IN and fully absent unless the binding exports a `judge` stage — judgment is expensive (extra model calls, position-swapped ⇒ 2x) and the whole cascade philosophy is 'push to outcome, judgment is last resort'; a binding without a judge behaves 100% as today.
- Rubric SOURCE: does the rubric decomposition come from the existing CriteriaFixture (acceptanceCriteria/redFlags already parsed per node) or a new product artifact? Recommended default: reuse CriteriaFixture.acceptanceCriteria as the atomic-attribute rubric seed passed to the injected judge — no new fixture, and it is already threaded into TriageOpts.criteria.
- Where does the abstain→human residual SURFACE for the human? Recommended default: as a new non-gating field on the Defect (abstainToHuman + a judgmentNote) rendered in the HERMES-ROUTING worklist and a distinct `judgment-abstained` OptimizeEvent — it joins the existing 'stage-for-human' batch, it does not create a new landing path.

---
## B2-tier23 — Tier-2/3 hardened judgment (informs ranking, never gates)

### 1. Goal & non-goals

**Goal.** Add the v1.5 §4b–§4d hardened-judgment cascade as a **ranking/triage-informing sidecar** that NEVER touches the two load-bearing scalars: `score.ts`'s Tier-0×Tier-1 fold and `replay.ts`'s accept comparator. Concretely:
- a **pairwise-vs-golden ranker** (position-swapped AB/BA vs a per-node golden), §4d Tier-2 bullet 1;
- **rubric decomposition** into atomic checkable attributes, §4d Tier-2 bullet 2;
- a **SEPARATE grounded critic** distinct from the producer, §4d Tier-2 bullet 3;
- **Tier-3 swap-consistency abstain → route-to-human**, §4d Tier-3;
- and — the crux — the **CHANNEL** that surfaces this judgment to triage/ranking **without** entering `score.ts`'s scalar or `replay.ts`'s accept.

**Non-goals (explicit, to protect the invariants).**
- NEVER add a `tier2` term to the `scoreNodes` fold in `score.ts:42` (the fold stays Tier-0×Tier-1; verified: `score.ts:7` header quarantines Tier-2, and `types.ts:77` documents the quarantine — this honors the HARD RULE).
- NEVER key `replay.ts` accept off judgment: `foldScore` (`replay.ts:70-73`) and `evaluateGate` (`gate.ts:42-62`) are untouched (honors "the checkable fraction gates deterministically; judgment INFORMS reflection and RANKS candidates but never solely accepts an edit", §4c/§4d).
- NO model/network/prompt call inside `@piflow/core` — the judge is INJECTED product-side (honors the SDK boundary law: core holds deterministic aggregation ONLY). The golden sample is product-side.
- This is single-node judgment aggregation; it does NOT implement B1-pareto's set-valued candidate selection (that's B1's job) — but it is *designed to compose* with it (§7).

### 2. What exists today (verified this run — no invented API)

- `score.ts:35-45` `scoreNodes` — PURE fold; `scalar` = `abstained ? null : tier0.disqualified ? 0 : tier1 ? tier1.scalar : null`. No judgment input. `score.ts:7` and `score.ts:15` pin the quarantine + the abstain rules.
- `types.ts:79-87` `NodeScore` = `{ node, tier0, tier1, scalar, abstained }`. Comment at `types.ts:77` says Tier-2 is "deliberately ABSENT … quarantined out of the verdict". No `tier2`/`judgment` field.
- `types.ts:131-146` `Defect` = `{ node, bucket, symptom, evidence[], confidence, needsSignal?, scope? }`. No abstain-to-human field.
- `triage.ts:40-63` `triage(scores, digest, opts)` → `Defect[]`, array-ordered by `scores` iteration order; buckets from observable signals; SKILL rides the recurrence index. `TriageOpts` (`triage.ts:25-32`) already carries `criteria?: CriteriaFixture` (currently "unused by the MVP buckets" — the rubric seam).
- `replay.ts:70-73` `foldScore` and `gate.ts:42-62` `evaluateGate` — the accept comparator; keyed on the Tier-0/1 scalar only. **Must stay untouched.**
- `events.ts:12-29` `OptimizeEvent` union + `renderOptimizeEvent` — the live surface; extend the union additively.
- `driver.ts` `runFixGate` and `loop.ts` `runOptimizeLoop` — the fix/gate/land control flow; judgment does NOT enter their accept path.
- CLI seam: `optimize-fix.ts:130-152` `scoreTriageEnrich` is the ONE worklist composition both `--fix` and `--rounds` share; `optimize-fix.ts:108-115` `enrichCodeMap` is the existing "resolve-at-read, mutate-defects-in-place" precedent — the judgment enrichment mirrors it exactly. `optimize-fix.ts:19-37` `OptimizeBinding` is where a product-side `judge?` stage is injected (mirrors `oracle`/`copyScope`/`fixer`).
- Golden: only `packages/core/test/fixtures/optimize/gs01.hermes-routing.golden.md` exists as a *fixture*; there is NO product golden-sample resolver in core — confirming the golden must be product-side (Open Question 1).

### 3. Design — the deterministic aggregation (core) vs the injected judge (product)

**Split by the invariant "model PROPOSES + SCORES; deterministic code DECIDES/BOUNDS".**

**(a) Core, PURE, new module `packages/core/src/optimize/judgment.ts`.** It holds the deterministic aggregation only — NO model call:
- `JudgeAttribute` — one rubric attribute's outcome: `{ id: string; describe?: string; pass: boolean }`. (Rubric decomposition into atomic checkable attributes, §4d bullet 2 — the judge answers many small observable questions, and core folds them.)
- `PairwiseVerdict` — one directional pairwise judgment: `{ order: 'candidate-first' | 'golden-first'; winner: 'candidate' | 'golden' | 'tie'; attributes: JudgeAttribute[] }`. Two of these (AB and BA) are the judge's raw output.
- `JudgmentInput` — `{ node: string; ab: PairwiseVerdict; ba: PairwiseVerdict }` (the two position-swapped runs).
- `JudgmentSignal` — the FOLDED, deterministic sidecar: `{ node: string; consistent: boolean; verdict: 'candidate-better' | 'golden-better' | 'tie' | 'abstain'; abstainToHuman: boolean; failedAttributes: string[]; note: string }`.
- `aggregateJudgment(input: JudgmentInput): JudgmentSignal` — the **Tier-3 swap-consistency rule, §4d Tier-3, verbatim**: normalize each directional verdict to a "does candidate beat golden?" boolean; if AB and BA AGREE → `consistent: true`, verdict = that agreement; if they FLIP → `consistent: false`, `verdict: 'abstain'`, `abstainToHuman: true` (position bias detected ⇒ route to the human as the eye). `failedAttributes` = the union of `attributes` with `pass:false` (surfaces rubric failures for the fixer/human — "narrow the human's choices", §4d bottom line). `note` = a deterministic one-line human string. **Never a number** — this is a rank/abstain signal, not a score (honors "judges rank far better than they score", §4d bullet 1).
- `foldJudgments(signals: JudgmentSignal[]): Map<string, JudgmentSignal>` — a keyed index by node for triage/score to attach.

**(b) Product, INJECTED (the model call lives here, per SDK boundary law).** A new optional binding stage in the CLI seam:
- `JudgePairwise = (node: string, ctx: { candidateRef?: string }) => Promise<JudgmentInput | null>` — product-side runs the SEPARATE grounded critic model (distinct from the producer/fixer — §4d bullet 3), TWICE (position-swapped candidate-vs-golden and golden-vs-candidate), decomposing quality per the node's rubric (seeded from `CriteriaFixture.acceptanceCriteria`, Open Question 3), and returns the two `PairwiseVerdict`s. Returns `null` when no golden exists / not applicable ⇒ the node carries NO judgment signal. **Core never sees a model, a prompt, a golden path, or the network.** The judge type lives in core (as a contract type) but is only *called* from the CLI/product seam.

### 4. The CHANNEL — how judgment reaches triage/ranking without touching the scalar

This is the load-bearing design decision. Three additive, quarantine-safe wires:

**Wire 1 — `NodeScore.judgment?` sidecar (attached AFTER the fold, never inside it).** Add an OPTIONAL field to `NodeScore` in `types.ts`:
```
/** Tier-2/3 hardened-judgment sidecar (v1.5 §4b–§4d). ADVISORY ONLY — INFORMS ranking/triage and NEVER
 *  enters `scalar` (the Tier-0×Tier-1 fold in score.ts) nor replay.ts's accept comparator. Set out-of-band
 *  by the injected pairwise judge; absent when no golden/judge applies. */
judgment?: JudgmentSignal;
```
`scoreNodes` in `score.ts` is **NOT changed** — it never reads or writes `judgment`; `scalar` is computed exactly as today. The sidecar is attached by a separate pure helper `attachJudgment(scores, index)` (in `judgment.ts`) that returns a shallow-copied `NodeScore[]` with `judgment` set where the index has the node — proving the fold and the sidecar are physically decoupled. This honors the HARD RULE literally: judgment data can ride on `NodeScore` but the scalar computation is provably independent of it.

**Wire 2 — triage RANKS the worklist and flags abstain (never changes the bucket's accept path).** In `triage.ts`, read `s.judgment` to:
- **Rank** — after building `defects[]`, stable-sort so judgment-informed defects order by (a) `abstainToHuman` first (needs the human eye), then (b) `golden-better` (candidate is worse than golden ⇒ higher-value fix), then existing order. This is the "narrow the human's choices / rank candidates" role (§4d bottom line, §4c "judge-assisted reflection"). Ranking changes ORDER only — never a bucket, never accept.
- **Flag** — carry the abstain onto the Defect via a new OPTIONAL field `abstainToHuman?: boolean` + `judgmentNote?: string` on `Defect` (types.ts). This is surfaced to the human batch; it does NOT change `bucket` and does NOT feed `gate.ts`. Crucially: a residual LAPSE/SKILL that the judge finds swap-INCONSISTENT is *flagged for the human*, matching `triage.ts:111`'s existing `needsSignal: '… or a prose-judge of the node skill'` — this is that prose-judge, finally wired, but as an ADVISORY flag, not a bucket override.

**Wire 3 — a non-gating event + worklist column.** Extend `OptimizeEvent` (`events.ts`) with `{ type: 'judgment-abstained'; node: string; note: string }` (fire-and-forget, same fire-and-forget contract as every other event) and render it in `renderOptimizeEvent`. Optionally extend `render.ts` `renderRouting` to append a `⚠ abstain→human` marker in the Symptom cell when `d.abstainToHuman` — advisory text only.

**What is deliberately NOT wired:** `gate.ts`, `replay.ts`, `driver.ts`'s accept decision, `loop.ts`'s convergence. Judgment reaches ranking + the human-batch surface and STOPS there. (Honors: "the accept gate keys on the deterministic tiers; judgment informs reflection and ranks candidates but never solely accepts an edit", §4d.)

### 5. CLI seam wiring (product-side, injected)

- `optimize-fix.ts`: add optional `judge?: JudgePairwise` to `OptimizeBinding` (like `run?`). In `loadBinding`, do NOT require it (back-compat: a binding without a judge behaves 100% as today — Open Question 2 default).
- In `scoreTriageEnrich` (`optimize-fix.ts:130`): after `triage(...)`, if the binding has a judge, add a new step `enrichJudgment(scores, defects, judge, criteria)` — mirroring the existing `enrichCodeMap` precedent (`optimize-fix.ts:108-115`, mutate-in-place, resolve-at-read, degrade silently). It calls the injected `judge` per candidate node, folds each `JudgmentInput` via core's `aggregateJudgment`, attaches to `NodeScore.judgment` via `attachJudgment`, re-runs the pure `triage` ranking OR (cleaner) passes the folded index into a new `TriageOpts.judgment?: Map<string, JudgmentSignal>` so triage does the ranking/flagging in one pure pass. **Prefer the `TriageOpts.judgment` route** — it keeps all judgment→worklist logic inside the pure `triage`, testable without the CLI. The CLI's only job is: call the injected judge, fold with `aggregateJudgment`, pass the map to `triage`.
- New `packages/cli/src/optimize-judge.ts` only if a standalone `optimize --judge <rundir>` read-only inspection command is wanted; **recommended default: NOT a new subcommand** — judgment rides the existing `--fix`/`--rounds` composition behind the opt-in binding stage (Open Question 2). Keep the file listed but treat it as optional/deferred.

### 6. Test-first plan (test comes BEFORE implementation; each test FAILS when the code is wrong)

**Test A — `optimize-judgment.test.ts` (the load-bearing test): the swap-consistency abstain rule.**
- `aggregateJudgment` with AB=`candidate wins`, BA=`candidate wins` (consistent) ⇒ `verdict:'candidate-better'`, `consistent:true`, `abstainToHuman:false`.
- AB=`candidate wins`, BA=`golden wins` (FLIP) ⇒ `verdict:'abstain'`, `consistent:false`, `abstainToHuman:true`. **This is the §4d Tier-3 rule and the load-bearing assertion.**
- `failedAttributes` = union of both directions' failing rubric attributes.
- **Test-the-test mutation (concrete):** flip the consistency check in `aggregateJudgment` from "AB and BA must AGREE" to "AB and BA must DISAGREE" (or hardcode `abstainToHuman:false`). The FLIP case must then wrongly report `consistent:true`/no-abstain and the test MUST fail. If the test still passes under this mutation, the test asserts nothing real — rewrite it. (Do not assert on `note` prose exactly — assert on the structured `verdict`/`abstainToHuman`/`failedAttributes`, the observable behavior, never unobservable intent.)

**Test B — `optimize-score-judgment-quarantine.test.ts` (proves the HARD RULE physically).** Build two `NodeScore`s identical except one has `judgment` set to `golden-better` and one to `candidate-better` (or abstain). Assert `scoreNodes` output `scalar` is byte-identical regardless of `judgment` — i.e. attach judgment AFTER `scoreNodes` and assert the scalar didn't move. Also assert `foldScore`/the replay path is never handed `judgment`. **Test-the-test mutation:** add a `+ (judgment==='golden-better'? -0.1 : 0)` term into `score.ts`'s scalar; this test MUST fail. This is the regression fence that keeps a future editor from leaking Tier-2 into the fold.

**Test C — `optimize-triage-judgment.test.ts`: the channel ranks + flags, never re-buckets.**
- Given scores whose judgment index marks node X `abstainToHuman` and node Y `golden-better`, and a plain node Z, assert the returned `Defect[]` ORDER is [X, Y, Z] and X's Defect has `abstainToHuman:true` + a `judgmentNote`, and the `bucket` of each defect is UNCHANGED from the no-judgment run (compare against `triage(scores, digest, {})`). **Test-the-test mutation:** make the ranking mutate `bucket` to `ARCH` on abstain; the "bucket unchanged" assertion MUST fail. This proves judgment informs ranking but never the bucket/accept path.

Use `test-discipline` skill before writing any of these (route: pure logic ⇒ unit + mutation gate; the injected judge is product-side model glue ⇒ NOT unit-tested in core, it's a contract type only). NEVER assert exact judge prose; NEVER fit assertions to current output.

### 7. Coupling & sequencing with A2 / B1 (from the KNOWN CROSS-TASK COUPLINGS)

- **A2-distiller** also edits `types.ts` (adds a root-cause field to `CandidateEdit`/`FixGateResult`). B2 adds sibling types (`JudgmentSignal`, `judgment?` on `NodeScore`, `abstainToHuman?`/`judgmentNote?` on `Defect`) to the SAME file. No logical conflict — different interfaces — but the same file ⇒ coordinate insertion points; land A2 first (it touches the fix-gate return shape B2 does not depend on but shares the file). Listed in `dependsOn`.
- **B1-pareto** makes candidates set-valued and may reorder the worklist. B2's judgment ranking reorders too. **These must be reconciled:** the Pareto front (B1) governs what's RETAINED for review; B2's judgment ranking governs the ORDER + the abstain flag within the human-review surface. Design them to compose: judgment ranks WITHIN a Defect list; Pareto operates at candidate selection. Land B1 first so B2's ranking sorts the final worklist shape. Listed in `dependsOn`. Flag in `sharedFileRisks` for `triage.ts`.
- **B4-fixer** edits `optimize-fix.ts` (landing/fixer). B2's `enrichJudgment` insertion in `scoreTriageEnrich` must not collide — coordinate the merge in that file.

### 8. Invariant self-audit (each choice cited)

- **"Model PROPOSES+SCORES; code DECIDES/BOUNDS."** → the judge is INJECTED (`JudgePairwise`, product-side); core holds only `aggregateJudgment`/`attachJudgment`/`triage`-ranking (deterministic). ✔
- **"Loop never mutates a live file."** → B2 adds NO landing path; judgment only reaches ranking + the human-batch surface. No file mutation anywhere in this task. ✔
- **SDK boundary law.** → the model call + the golden sample are product-side (CLI `OptimizeBinding.judge`); core is product-agnostic (folds an opaque `JudgmentInput`, never resolves a golden or calls a model). ✔
- **Pointer + resolve-at-read.** → judgment does not embed golden bodies; it folds the judge's verdicts; the golden stays product-side and resolve-at-judge-time (mirrors `enrichCodeMap`'s resolve-at-read). ✔
- **The HARD RULE (never into `score.ts` scalar nor `replay.ts` accept).** → Test B is the physical fence; `scoreNodes` and `foldScore`/`evaluateGate` are provably untouched. ✔
- **test-first + mutation-verified, no over-hardcoding.** → §6 gives each test a concrete test-the-test mutation and asserts structured observable behavior, never prose/intent. ✔

### 9. Execution order for the future executor

1. (After A2 + B1 land.) Get user SIGN-OFF (this task `needsSignoff`) — resolve the four Open Questions, especially the golden-sample location (OQ1) and opt-in vs default (OQ2).
2. Write Test A, B, C FIRST (they fail — no impl yet).
3. Add types to `types.ts` (`JudgmentSignal` + siblings; `NodeScore.judgment?`; `Defect.abstainToHuman?`/`judgmentNote?`).
4. Implement `judgment.ts` (`aggregateJudgment`, `attachJudgment`, `foldJudgments`) → Test A + B green.
5. Extend `triage.ts` (`TriageOpts.judgment?`, ranking + flag) → Test C green.
6. Extend `events.ts` (`judgment-abstained` event + render) and optionally `render.ts` (advisory marker).
7. Export the new surface from `index.ts`.
8. Wire the injected `judge?` into `OptimizeBinding` + `scoreTriageEnrich` in `optimize-fix.ts` (opt-in, degrade-silently, mirror `enrichCodeMap`).
9. Run mutation checks per §6; run the full optimize test suite; confirm `scoreNodes`/`replay`/`gate` behavior is byte-identical to pre-B2.

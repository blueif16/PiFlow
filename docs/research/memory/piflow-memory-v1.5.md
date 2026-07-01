# piflow memory v1.5 — four-way triage + the scoring question

> Builds on `piflow-memory-v1.md` (the substrate, the two legs, the §7 triage→fixer→reconcile meta-DAG).
> v1.5 changes three things: **(A)** it makes credit-assignment a **FOUR-way** first-class triage output
> (v1 routed blame only to a *node*, not to a *side*); **(B)** it disambiguates **which gate we mean** — the
> *within-run quality gate* piflow already ships vs the *across-run optimization gate* that is new; **(C)** it
> names **scoring** as the single missing component and frames it as the open question under active research.
> Externally validated by SkillOpt (`vendor/SkillOpt@9969a8f`, see `vendor-skillopt-mastra-2026-06-29.md`).
>
> **Status (2026-06-29):** the four-way triage (§3) and the gate clarification (§2) are FIRM. The scoring
> design (§4) is now **research-grounded** (three Exa briefs folded into §4d) — the cascade is settled in
> principle; the held-out replay+scoring HARNESS that feeds it (§5.1) is the remaining critical path to build.
>
> **Update (2026-07-01):** the **Leg-A ↔ Leg-B cross-reference is WIRED**. A SKILL defect now carries a two-leg
> `DefectScope` — cross-run recurrence + the lesson's distilled root/prevention (Leg A) + the lesson's
> `[[okf-slice]]` link (Leg B) — and the CLI seam dereferences that link to the slice's curated code-map at fix
> time (`resolveSlice` → `enrichCodeMap`), so the fixer reads *how the code works* beside *what recurred*. The
> store-side fork (embed a condensed copy vs. keep the legs separate and resolve the link) is **CLOSED for
> POINTER + RESOLVE-AT-READ — never an embedded copy**: confirmed 2026-07-01 by an external SOTA sweep (cache-
> coherence / GitOfThoughts fusion-buys-nothing / Memex-RL dereference-on-demand) *and* our own "pointers +
> semantics, never a copy" law (v1 §5b) — a copy has no `--check` to ride, so a lesson's freshness rides the
> linked slice's gate instead. Captured in the `memory-leg` + `optimize` OKF slices (the understanding system
> holds the decision).
>
> **Update (2026-07-01, cont.):** the OVERLORD is now ASSEMBLED end-to-end in `@piflow/core` + the CLI. Shipped
> this pass (all thin/deterministic-driver + injected-stage, SkillOpt §7 + goalmode §4 grounded; test-first,
> mutation-verified): **(1)** the multi-round loop `runOptimizeLoop` (`optimize/loop.ts`) — a thin driver over
> injected `run→score+triage→fix+gate→memorize` stages with CONVERGED/STALLED early-stop + a circuit-breaker
> (goalmode's "honest reconciliation": the outcome gate IS the verifier, so early-stop is deterministic);
> **(2)** cap/retire compaction `compactMemory` (`optimize/compact.ts`, §5.3) — deletes discrete lowest-value
> lessons, never re-summarizes (ACE); **(3)** the MEMORIZE distillation seam `fillLessonProse`/`distillLesson`
> (`optimize/distill.ts`) — turns the `(pending …)` placeholders into real prose, the model INJECTED as a
> `LessonDistiller` (core holds no model/network); **(4)** CLI activation — single-shot `optimize --fix` now
> MEMORIZEs (closes the cross-invocation recurrence loop) + `optimize --rounds N` (autonomous-propose) composes
> the loop with a product `run` binding; **(5)** the LONG-HORIZON outer-loop SEAM `runLongHorizon`
> (`optimize/long-horizon.ts`) — the counterpart to the multi-round loop: each GENERATION optimizes workflow W,
> then an INJECTED redesign subgraph authors the blueprint of the next workflow W' (analyze past nodes → design
> future nodes). Still deferred (the named STOPs): the **redesign subgraph** itself (self-design intelligence,
> product-side) + its `--generations` CLI wiring; multi-candidate **Pareto** at FIX+GATE (goalmode's #1 gap);
> Tier-2/3 hardened judgment (§4d); a `piflowctl memory find|check` verb.

---

## 1. What v1.5 changes vs v1 (and what it does NOT)

| | v1 | v1.5 |
|---|---|---|
| Blame attribution | triage routes a defect to a **node** (§7) | triage ALSO routes it to a **side** — one of four buckets (§3) |
| "Gate" | left implicit; conflated human-approve with quality | **two distinct gates named** (§2): within-run (HAVE) vs across-run-optimization (NEW) |
| Scoring | assumed `run-status.json` is enough for triage | **named as the missing component** (§4); two scoring *jobs* separated |
| Substrate | the two-leg files (shipped) | **unchanged** — v1.5 is method, not new storage |

v1.5 does **not** change the storage layout, the two legs, the data boundary, or the human-gated
no-silent-learning law. It sharpens the *decision* the optimizer makes and the *signal* it needs.

## 2. The gate we already have vs the gate we need (do NOT conflate them)

piflow already ships a rich **within-run quality gate** — this is the gate that exists in the code:
- per-node **`checks.post`** over produced artifacts (`scaffold.ts` → `node.checks.post[]`: `non-empty`,
  `schema`, …); the loader/driver runs them after the node;
- **`policy.fail`** = `block | warn | stop` (`node.policy.fail`), plus **`retries`** (extra attempts), the
  **G8 repair** loop, **escalate-with-evidence**, and **bounded reroute** (the within-run self-correction story);
- per-node **`schema`** validation and required **`artifacts`** the driver `stat()`s.

**That gate answers one question: "did THIS run's artifact pass its contract?"** It drives retry / repair /
escalate **inside a single run**. It is real, shipped, and not the gap.

The gate v1.5 adds is a different question entirely:

> **Across-run optimization gate:** after the optimizer EDITS the system (a prompt, a skill, a config, or
> product code), does **re-running** the affected node/sub-DAG on a **held-out task slice** produce a
> **better score** than before the edit? Accept the edit **only if it strictly improves**; otherwise reject and
> remember it as negative feedback.

This is SkillOpt's `evaluate_gate` (`vendor/SkillOpt/skillopt/evaluation/gate.py:123` — literally
`if cand_score > current_score:`). It is what keeps a self-editing loop from drifting (the Library-Drift
guarantee). **piflow has the within-run gate; it does NOT have this across-run gate, and it does not have the
SCORE the gate compares on.** That score is §4 — the actual missing component.

**The bridge:** the within-run `checks` are mostly **pass/fail per artifact**; the across-run gate needs a
**comparable scalar** on held-out tasks. We can reuse `checks` as one *input* to the score, but a binary pass
is not yet a score that says "the new prompt is *better*, not just *still-passing*."

## 3. The four-way triage (the credit-assignment crux, made first-class)

v1's triage assigned each defect to a **node**. v1.5 requires triage to also assign it to **one of four
buckets**, because the *fix surface* and the *gate* differ per bucket. Buckets are ordered by **ascending
blast radius**; triage checks cheapest-first and — borrowing SkillOpt's corpus-protection rule
(`optimizer/skill_aware.py:77`, *"when genuinely unsure, choose EXECUTION_LAPSE"*) — **defaults toward the
lower-blast-radius bucket when uncertain.**

**The discrimination test (run top-down; stop at the first YES):**

**① EXECUTION_LAPSE — the skill was right; the executor slipped.**
*Test: "Is there a rule already in the node's `prompt.md`/`SKILL.md`/contract that, if followed, would have
prevented this failure?"* → YES.
- **Do NOT edit the prose** — editing a correct rule over a one-off slip is exactly how the corpus rots.
- Response is one of: (a) a short reminder in a **protected appendix** region (SkillOpt's `appendix_notes`,
  `skill_aware.py:82-85`), consolidated under a threshold; (b) **piflow-specific** — a lapse is often a
  *weak-model/tier* or *transient* symptom, so the right across-run fix is a **routing change** (bump
  `model`/`tier`/`provider` in `node.json`), not a content edit; within-run it is already handled by
  retry/escalate/reroute (§2).
- **This is the bucket v1's framing did not have.** It is the guard that lets the loop run without degrading
  a working skill. *(Maps to the agent-memory law "reflect on failures, never reward-hack a correct rule.")*

**② SKILL_DEFECT — the prose is wrong, missing, or underspecified.**
*Test: no correct rule exists (or the existing one is wrong).* → edit the **envelope**: `prompt.md` /
`SKILL.md` / `node.json` (tools, inject, contract). **Match the edit FORM to the failure TYPE** (hermes law 4):
shaping→positive recipe; omission→a REQUIRED output slot; conditional→a rule keyed to an observable
predicate; discipline-lapse→prohibition + rationalization table.
- **Gate:** `skillsys(<node>)` commit + human eye (cheap, reversible) + the across-run gate (§2) once a score exists.

**③ FUNCTIONALITY_DEFECT — the prose is fine; the product CODE the node operates on is wrong.**
*Test: a faithful executor following a correct skill still fails because the code in scope is buggy.* → edit
**project code within `owns`/`readScope`** (the runtime jail = the optimization blast radius, v1 §5a).
- **Gate is STRICTER than ②:** a code edit MUST additionally pass the **product's own tests / typecheck /
  build** — not the human eye alone (the `test-discipline` + `systematic-debugging` contract). Higher blast
  radius ⇒ harder gate. `skillsys` records it.
- **No external prior art** (SkillOpt + Mastra both edit prose only) — this is piflow's distinctive bet and
  its least-de-risked branch; prototype it most carefully, gated by re-running tests.

**④ COORDINATION / ARCHITECTURE — the fix escapes the node's scope, or it is a cross-node wiring/contract flaw.**
*Test: the root cause is a hand-off, a shared contract, a missing/mis-wired node, or a fix that must touch
code outside this node's `owns`.* → **route UP to reconcile**; may rewire or add a node (L2 COMPOSE).
- **Gate:** the heavyweight human structural gate (hermes law 3: a structural change always takes an explicit
  yes). Per law 4, *prefer fixing the chain / a declared contract over a per-node reactive guard.*

**Triage output, per defect:** `{ node, bucket ∈ {LAPSE, SKILL, FUNCTIONALITY, ARCH}, evidence }`. The bucket
selects both the fixer's edit surface (v1 §6) and the gate. The ① default-when-unsure protects the corpus;
②/③ are the two real "edit" paths (prose vs code), split by the harder gate ③ carries; ④ is the route-up.

## 4. Scoring — the single missing component (the open question)

The across-run gate (§2), the four-way triage's confidence (§3), and the retire-by-contribution metric (v1
§10.1) **all depend on a score we do not yet produce.** This section frames the problem; the design is open.

### 4a. Two scoring JOBS, not one (the key separation)

Conflating these is the trap. They have different sources, different reliability, and feed different consumers:

- **Job A — the DIAGNOSTIC signal (feeds TRIAGE / blame-routing, §3).** Read off the **telemetry trace**:
  tokens, latency, the tool-call log, retries, escalations — plus a **check-model** reading the trace for
  *symptoms* (overthinking, hallucination, tool thrash). It answers **WHY/WHERE** a run went wrong, which
  routes the bucket. We already run a producer model + a separate **check** model, so this structure exists.
  **But these are PROXIES/symptoms, not quality** — and "more time spent" is **ambiguous** (could be careful
  work or could be thrashing). → Job A is strong as a *diagnostic for routing*; it is **not** a standalone
  quality score. *(Reliability of trace signals: research lane `eval-trajectory-process-scoring-2026-06.md`.)*

- **Job B — the QUALITY signal (feeds the GATE, §2).** Did the artifact **meet the bar**? Decides
  accept/reject of an edit. Source hierarchy, **most-trustworthy first** — push the score down this list as
  far as the artifact allows:
  1. **Outcome / checkable** *(preferred — no judge, no false confidence)*: code passes tests, schema
     validates, declared gameplay behaviors pass authored checks, the node's existing `checks.post`. This is
     exactly what SkillOpt's gate scores on — **held-out task success** (`gate.py`, `utils/scoring.py`
     hard/soft), never an LLM's self-assessment of its own edit.
  2. **Golden-sample / reference-anchored judgment** *(we already keep per-node criteria + a golden sample)*:
     compare the artifact to the golden via a judge, **pairwise/reference-anchored** rather than absolute.
  3. **Model judgment, hardened** *(last resort — irreducibly subjective / visual)*: see §4b.

### 4b. The false-confidence problem (why we cannot naively trust the judge)

The core worry: **a model reflects, fails to spot the real defect, and reports success with high confidence**
— worst on visuals. A single self-reviewing judge carries a measured self-enhancement bias (~5–7%,
`agentic-prompt-design §4`) and "polishes errors it cannot see." The structural answers (to be quantified by
the research lanes):
1. **Prefer OUTCOME over JUDGMENT wherever the artifact is checkable** (§4a.B.1). SkillOpt's whole trick is
   that the gate signal is an *outcome* (task success), so the judge's false confidence never enters the gate.
2. **The critic must be a SEPARATE node/model from the producer** — a forced perspective shift a self-review
   cannot fake (already our implement-model vs check-model split; hermes `node-validation-loop`'s
   independent judge).
3. **Decompose quality into checkable attributes** (a rubric) so the judge answers many small *observable*
   questions, not one "is it good?".
4. **Reference/pairwise-anchor** to the golden sample (A-vs-golden, not absolute).
5. **Calibration / abstention** — when the judge is unsure, **route to the human** (hermes law 3: *the human
   is the eye for visual artifacts*). The human stays the eye precisely where Job-B confidence is lowest.

### 4c. The organizing principle

> **Outcome-gated accept · judge-assisted reflection · NEVER judge-gated accept.** Push the score toward
> OUTCOME and away from JUDGMENT as far as the artifact allows: the checkable fraction (code, schema, testable
> behaviors, groundable visuals) gates deterministically; the irreducible-judgment residual (visual/aesthetic
> taste) gets a *hardened, pairwise* judge whose abstention routes to the human as the eye. Telemetry is a
> **diagnostic + a deterministic disqualifier**, never a standalone quality score.

### 4d. The scoring cascade (research-grounded 2026-06-29)

The three Exa lanes (briefs at the end of this section) converge on ONE architecture: **a tiered cascade,
cheapest-and-most-trustworthy first, that ABSTAINS to the human exactly where model confidence is unreliable.**
The accept gate (§2) keys on the deterministic tiers; judgment *informs reflection and ranks candidates* but
never solely accepts an edit.

**Tier 0 — deterministic trace gates (judgment-free; from telemetry).** Disqualify a run on structural failure
patterns read straight off the tool-call log: loops, retry storms, ungrounded tool use, runaway/non-monotonic
tokens, missing termination. No model needed (SentinelRCA; TRAJEVAL "22× over-search", arXiv 2603.24631;
GroundedPRM). This is a *pre-filter* + the diagnostic that routes the §3 bucket — **NOT** a quality score.
("More time" is **non-monotonic** — right→wrong flips overtake beyond ~7K tokens, arXiv 2604.10739 — so token
count is a difficulty-conditioned *risk* signal, never a grade.)

**Tier 1 — outcome / checkable (the preferred quality signal; what the accept gate keys on).** Tests pass,
schema validates, declared behaviors pass authored `checks.post`; for visuals, **render-and-diff / symbolic
grounding** wherever a ground truth exists (Verity, parity-studio for UI; SceneCritic arXiv 2604.13035 beats
judging-from-renders for 3D). Deterministic ⇒ no false confidence. This is SkillOpt's gate signal (held-out
task success, `gate.py:123`).

**Tier 2 — hardened judgment, for the residual Tier 1 cannot check.** Three measured, non-negotiable mechanisms:
- **PAIRWISE vs the golden sample, never absolute scoring** — judges *rank* far better than they *score*
  (GenArena arXiv 2602.06013: Spearman 0.36→0.86; "VLM Judges Can Rank but Cannot Score" arXiv 2604.25235:
  only 32–34% absolute agreement). We already keep a per-node golden sample — judge candidate-vs-golden.
- **Rubric decomposition into atomic checkable attributes** — turn "is it good?" into many small *observable*
  questions verified against the artifact (RRD arXiv 2602.05125: +17.7pp; rubric-conditioning lifts a verifier
  20→93%).
- **A SEPARATE, grounded critic ≠ the producer** — self-checking only verifies at its own accuracy; an
  evidence-gated independent critic is the only setup measured to beat single-agent (arXiv 2606.02866). (We
  already split implement-model vs check-model.)

**Tier 3 — abstain → HUMAN (the eye).** The abstention TRIGGER is **consistency, never self-reported
confidence** — verbalized confidence is ≈0.999 even on hallucinations (ECE 0.443) and logprobs saturate at
99.4–100% (Verdi arXiv 2605.11334). The reliable trigger is **position-swap-and-keep-only-consistent**: run
A-vs-golden and golden-vs-A; if the verdict flips, ABSTAIN (debiases position bias AND doubles as a free
abstention filter; arXiv 2606.18451). Below a conformal-interval threshold, route to the human (hermes law 3 —
the human is the eye for visual artifacts). This is the principled home of the **~59% of judge errors that are
internally-consistent-but-wrong and invisible to any model-internal signal** — only an external check or a
human catches them.

**Bottom line — "can we trust the model's quality judgment as ground truth?"** Only (a) when backed by a
Tier-0/1 checkable outcome, or (b) as a Tier-2 *pairwise, rubric-decomposed, reference-anchored, swap-consistent*
ranker — and even then with ~20–30% residual disagreement and a confidently-wrong tail. **For pure visual taste
with no ground truth, the accept gate IS the human; the model's job is to NARROW the human's choices (rank +
surface rubric failures), not replace the eye.** That is the most we can honestly do — and it is a lot, because
most of an artifact (code, schema, behaviors, groundable visuals) lives in Tier 0/1 where there is *no*
false-confidence problem at all; the irreducible human residual is smaller than it feels.

**Briefs (exact mechanisms cited within):** `eval-llm-judge-reliability-2026-06.md` ·
`eval-trajectory-process-scoring-2026-06.md` · `eval-visual-perceptual-quality-2026-06.md`.

## 5. Open questions carried into v1.5

1. **The held-out task-replay + scoring harness** — the prerequisite for §2's gate and §4.B.1. piflow has no
   replay/scoring harness; SkillOpt *mines checkable tasks from transcripts* (`skillopt_sleep/cycle.py:191`).
   What is piflow's analogue — mine a checkable task from a node's run trace, re-score a candidate edit on it?
   **This is the true critical path; everything in §2–§4 is downstream of it.**
2. **The score function itself** — how to combine Job-A diagnostic + Job-B quality (and the
   outcome/golden/judge tiers) into the scalar §2 compares on. Weighting telemetry: low (diagnostic), per §4c.
3. **Caps + the retire-by-contribution metric** (v1 §10.1) — now expressible once a score exists.
4. **Where the judge abstains → human** — the UX of the calibration hand-off (per-edit vs batched).

## 6. The autonomous optimization loop — the overlord

**Who is in charge: a deterministic, run-count-bounded DRIVER — NOT an agent.** Control flow is CODE; the
intelligence lives only in the bounded STAGES (score is mostly deterministic; triage + fix are model-driven but
evidence-grounded). This is SkillOpt's `skillopt_sleep/cycle.py` pattern and the "move flow control into the
harness, not the prompt" rule. The driver COMPOSES the method (`hermes-skill-system`) and the piflow binding
(`piflow-enhance`); it does not fork them.

**The loop (one round ≈ one SkillOpt "epoch"):**
```
for round in 1..N:                              # N = the run-count BUDGET (not the safety)
  RUN      game-omni --profile companion        # NO verify gate → RAW producer output (un-masked)
  SCORE    out-of-band: Tier-0 telemetry (disqualifier) + Tier-1 lifted-verify-checks (value)   # §7
  TRIAGE   four-way projector → {node, bucket, evidence}    # automates HERMES-ROUTING; default-unsure = LAPSE
  FIX      per blamed node: a context-isolated fixer edits within scope (envelope | product code)
  GATE     re-run the fixed node on a HELD-OUT prompt-suite slice; accept iff the score STRICTLY improves
  LAND     outcome-gated win → auto-commit skillsys(<node>);  judgment edit → STAGE for the human
  MEMORIZE write the lesson to the node's memory.md (Leg A); recurrence accumulates across rounds
between rounds: reconcile (ONLY step that edits the template) · cap/freshness on memory.md · rejected-edit buffer
end: present the staged judgment-edits + the round-by-round score TRAJECTORY to the human
```

**The critical correction to "the only limit is a run count":** the run count is the BUDGET, not the SAFETY.
Library-Drift measured autonomous self-editing at **+0.0pp** without a curation gate. Two bounds are MANDATORY
or the loop degrades: **(1)** the per-edit OUTCOME gate (accept iff the held-out score improves) — this, not the
count, is what stops drift; **(2)** the human approve-edge for JUDGMENT edits (never judge-gated auto-land) + a
rejected-edit buffer (don't re-propose a dead edit).

**Control invariants (verbatim from SkillOpt's working `skillopt_sleep`, file-cited — copy these):**
- **The model PROPOSES + SCORES; deterministic code DECIDES, BOUNDS, and LANDS — and the loop NEVER mutates the
  live file.** The driver is straight-line code (`cycle.py:90`); the LLM is confined to inner stages; the gate is
  pure arithmetic over model-produced scores (`gate.py:43-50`).
- **Gate on a CANDIDATE COPY, never the live doc** (`consolidate.py:112-134`); accept predicate = `≥1 edit
  applied AND final_score > base_score` (`consolidate.py:222`); on reject, fall back to the original.
- **VAL hygiene:** the held-out slice the gate scores on is NEVER polluted — replay/recall only enlarge the
  TRAIN slice; test is never used as val (`consolidate.py:54-58`). piflow's mined tasks must carry a train/val
  split tag.
- **LAND = a staging dir + a manifest** (`staging.py:39-72`); auto-land fires ONLY when gate-accepted AND a
  pre-authorized flag is set (`auto_adopt`, default OFF, `cycle.py:286-288`), else it waits for an explicit
  human `adopt` that backs up before overwriting. → piflow's "auto-commit vs stage-for-human" IS this staging
  seam: make `auto_adopt` a **per-target policy** (outcome-gated targets auto-adopt; judgment targets require
  human adopt).
- **Bound by HARD CAPS, not just the round count:** a per-round `edit_budget` (SkillOpt = 4 — the "learning
  rate"), a token budget, and a lookback window (`config.py:31-43`). (SkillOpt fires one round per cron; piflow's
  in-process N-round loop is the trainer-epoch analogue — same caps apply per round.)

**SOTA completeness additions (gap-check vs Codex `/goal` + 2026 loop patterns, `eval-codex-goalmode-loop-patterns-2026-06.md`).**
The control plane above is sound (deterministic driver · propose/score/gate/land · maker-verifier · human gate · caps — all
independently confirmed). Four additions close the gap to SOTA:
1. **Condition-based early-stop (not just run-count).** Codex `/goal`, Ralph, and GEPA all stop on a VERIFIABLE CONDITION,
   not a fixed N. Keep N as the budget CEILING, but stop early on: all triaged defects resolved (converged) OR no accepted
   edit for K rounds (stalled → escalate to human). [corrects the "only limit is run count" / SkillOpt no-patience design.]
2. **Multi-candidate Pareto selection at FIX+GATE (the most important — phase-2).** A single-incumbent strict-improvement
   SCALAR ratchet sticks in local optima and discards candidates that are worse-on-average but better on a hard task slice
   (GEPA arXiv 2507.19457: +19pp at 35× fewer rollouts; AlphaEvolve arXiv 2506.13131). So FIX proposes SEVERAL candidates;
   GATE scores them PER-TASK over the held-out slice and keeps a Pareto front (winners on different subsets), merging
   complementary ones. The strict-improvement gate still governs what AUTO-LANDS (safety); the Pareto front governs what's
   RETAINED for merge/human review. [richer FIX+GATE — after the single-candidate MVP.]
3. **A RAIL circuit breaker for long autonomous runs.** Beyond the hard caps, a breaker that trips mid-loop on
   error-rate / spend / runaway and resumes only on logged human re-auth (LoopRails; RAIL = Reversible·Authorized·
   Interruptible·Logged). Composes with the sandbox jail + the human gate.
4. **ACE incremental-delta MEMORIZE — NOT full-rewrite consolidation.** Full-rewrite consolidation CAUSES context collapse
   (ACE arXiv 2510.04618: 66.7%→57.1% in one step). So MEMORIZE appends / updates / retires DISCRETE lessons (deltas) under
   the cap, with periodic out-of-band compaction — it NEVER LLM-rewrites the whole `memory.md` into a fresh summary.
   [refines v1 §9 "consolidate-under-pressure": consolidate by retiring discrete entries, not by re-summarizing.]

**Modes (autonomy = two axes: run-budget × accept-authority):**
- **Companion (exists):** dev-time, human babysits each stage, no loop, nothing auto-lands. The "warm-up run."
- **Autonomous-propose (the build target — the "5 runs"):** the driver runs N rounds; **outcome-gated**
  (deterministic Tier-0/1) wins auto-commit; **judgment** (Tier-2/3) edits STAGE for one human batch-approve at
  the end. Bounded by run-count + token budget.
- **Autonomous-apply (NOT recommended):** even judgment edits auto-land — ruled out by Library-Drift +
  "never judge-gated accept."

**Where it lives:** the driver + score + triage + fixer-dispatch = `@piflow/core` `optimize/` (product-agnostic),
invoked `piflowctl optimize --rounds N --profile companion <template>`. The METHOD = `hermes-skill-system`. The
piflow precedence + the criteria/golden maintenance = `piflow-enhance` (fill the stub to GOVERN this loop,
composing hermes — it already owns the criteria fixture + Companion-Mode judging). Criteria/golden/prompt-suites
stay product-side (game-omni).

**Dogfood-the-design first:** prototype this loop over game-omni with a deterministic orchestration pass
(run→score→triage→fix→gate ×N), validate the shape AND measure whether it lifts the post-migration-stagnant
pipeline, THEN port the validated loop into `@piflow/core`. game-omni's empty `memory.md` is the blank-slate
proof. **The concrete "it works" test (from `game-omni-presdk-era-2026-06-29.md`):** run game-omni twice across a
banked fix (e.g. gs01's `maxScore===0`, or the `hook.ts:138-139` destroyed-group read) — the SECOND run does NOT
re-hit the bug the first recorded, you can point at a tracked, non-empty per-node `memory.md` that carried that
knowledge across the run boundary (absent today: `find .piflow/game-omni/template -iname 'memory*.md'` is empty),
and archetype pass-rate trends up across `flowCommit`s in the eval trail. **What was LOST at the SDK migration is
exactly this loop** — the workflow + skills migrated 1:1, but the human-mediated `hermes-routing.md` → `skillsys()`
→ OKF `_lesson:_` self-improvement loop went silent after 06-19. v1.5's job is to AUTOMATE that loop.

## 7. The first build — the out-of-band Score + Triage pass (spec shape)

Pure, read-only, OUT-OF-BAND (post-run; NEVER an in-DAG node — the "curation off the critical path" rule).
Inputs from a real run dir + the product's criteria; output = the worklist the fixer consumes (= the automated
`HERMES-ROUTING.md`).
```
scoreRun(runDir, criteriaFixture) → NodeScore[]
  per node: { node, tier0:{anomalies[], disqualified}, tier1:{checks:{id,passed}[], scalar}, tier2?:{verdict, abstained} }
  · Tier-0  ← observe/telemetry.ts projectRunDigest (SHIPPED — loops/retries/truncation/context)
  · Tier-1  ← VERIFY-2's measure is ALREADY a standalone model-free CLI (`runMilestoneVerify2`/`verify-milestone`,
              harness.ts:533 — "no self-fix loop", exits 0): the Score pass = RUN THE HARNESS on the raw build +
              ignore the agent. VERIFY-1's C1–C8 math is fused into a model turn (SKILL.md:300-316) → lift the
              re-derivation (or recode the arithmetic). + the node's checks.post.
  · ABSTAIN ← "measure could not run" (missing `blueprint.declaredRanges` / non-terminal milestone / boot-fail,
              perturbation.ts:119-121) is a DISTINCT abstain — NEVER scored as a low value.
  · scalar  = fold(tier0-disqualifier × tier1-value); Tier-2 is SMALL + ALREADY quarantined out of the verdict
              (VERIFY-1 C9 fantasy/pacing → human eye; VERIFY-2 advisory VLM → non-blocking) — judgment only there.
triage(scores, runDigest, priorRuns+memory) → Defect[]
  per defect: { node, bucket ∈ {LAPSE,SKILL,FUNCTIONALITY,ARCH}, evidence, confidence }
  · ARCH           ← HALT class + upstream localization (telemetry.ts, SHIPPED)
  · LAPSE          ← escalation-succeeded-unchanged (retry FSM); DEFAULT when unsure (protect corpus)
  · SKILL          ← cross-run recurrence (needs priorRuns + memory.md — the FIRST real READER of Leg-A)
  · FUNCTIONALITY  ← product-test-fails-while-prose-checks-pass (needs product-test-as-node-outcome — to build)
  · writes nothing; emits the worklist
```
The two buckets it can't yet decide (SKILL needs recurrence, FUNCTIONALITY needs the product-test signal) NAME
the next two signals to add — and SKILL's recurrence is exactly what gives Leg-A `memory.md` its first READER.

**The output FORMAT is already proven (don't invent it).** game-omni's pre-SDK human loop produced exactly these
artifacts — so the projector's output = the `hermes-routing.md` shape (`Symptom → Trace@path:line → Root cause →
Owner/route → generalization + anti-reward-hack → smallest durable edit`; e.g. `_prior-runs/gs01/hermes-routing.md:17-37`),
and the MEMORIZE step's durable distillation = the OKF `log.md` `_lesson:_` line. The optimizer automates a record
a human used to hand-write; reproduce its shape, don't design a new one.

## 8. Grounding & provenance — every research file, and where it lands

**This doc is the canonical source of truth for the optimization layer; the folder `README.md` is a thin pointer
here, NOT a second catalog.** Each file under `docs/research/memory/` is referenced once below (and inline where
its finding is used):
- **Prior canon (the substrate this builds on):** `piflow-memory-v1.md` (the two legs + the §2 scaffold, SHIPPED)
  · `harvested-practices.md` (the Hermes / RondoFlow / ADK harvest + the four-memory framing).
- **Leg B — code understanding (world/code), the loop's code-context input:** `code-understanding-and-anti-drift.md`
  (the function/vertical lifecycle slice + the internal anti-drift cascade + the experiment backlog; supersedes
  `v1 §5b`'s design depth) · `anti-drift-sota-2026-06-30.md` (the SOTA survey grounding that cascade).
- **The scoring cascade (§4):** `eval-llm-judge-reliability-2026-06.md` · `eval-trajectory-process-scoring-2026-06.md`
  · `eval-visual-perceptual-quality-2026-06.md`.
- **The overlord + its SOTA additions (§6):** `skillopt-sleep-loop-control-2026-06-29.md` (the loop-control
  reference — driver shape, gate placement, stage→adopt, caps) · `vendor-skillopt-mastra-2026-06-29.md` (the
  held-out gate + the SKILL_DEFECT/EXECUTION_LAPSE classifier; Mastra as the no-self-optimization contrast) ·
  `eval-codex-goalmode-loop-patterns-2026-06.md` (the gap-check → the four additions).
- **What the SDK emits today (§2, §5, §7):** `gap-analysis-optimizer-substrate-2026-06-29.md` (Tier-0 telemetry
  ~built, Tier-1 binary; the replay harness + scalar + triage projector are the gaps; the prioritized build list).
- **The dogfood target — game-omni (§4, §6, §7):** `game-omni-sdk-wiring-2026-06-29.md` (the 16-node DAG; the
  run-scoped MEMORY practice vs Leg-A) · `game-omni-quality-assets-and-sdk-gap-2026-06-29.md` (the criteria
  fixture covering all nodes; the eval prompt-suites; the live codegraph/OKF; the NODE×OUTPUT×tier matrix) ·
  `game-omni-verify-extraction-2026-06-29.md` (Tier-1 = the standalone `verify-milestone` CLI; the ABSTAIN rule;
  dropping the gate in dogfood is clean) · `game-omni-presdk-era-2026-06-29.md` (what the migration LOST; the
  proven `hermes-routing.md` / OKF `_lesson:_` output shapes; the concrete success test).

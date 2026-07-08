# Optimize loop — the verification half (design)

> Status: DESIGN (2026-07-08). Branch `feat/triage-live-overlord`. Grounds the "what happens AFTER the
> fixer applies the fix" thread. Backed by a 4-lane external research sweep (APR/overfitting · industrial &
> agentic loops · independent-verifier/anti-reward-hacking · rerun rationing) — sources at the end.
> Companion to `docs/handoff-w0-optimization.md`. §2 is the research reframe (still valid); §0 records the
> human design review that corrected the over-engineering and what actually SHIPPED.

## 0. Post-review corrections + what shipped (SUPERSEDES the ambition in §3 / §6 / §7 where they conflict)

A design review with the human deliberately thinned the below. The shipped v1:

- **No invented "fix contract."** We do NOT synthesize a per-fix contract or held-out probes (§6). Verifying a
  fix = re-run the node and judge it against the node's OWN bar — the exact same `optimize.judge` criteria a
  regular run / companion judge uses. The oracle stays withheld from the fixer (already true); that is the only
  fence needed. "Are we going to invent a contract every time? Don't be silly."
- **The gate agent is a THIN base-agent child, not a subsystem.** Like `piflow-triage`/`piflow-fixer`: a SKILL
  (`piflow-gate/SKILL.md` — the judgment) + a `judge.ts`-shaped module (`optimize/substrate/gate.ts` — assemble
  → `runBaseAgent` → fail-closed `verdict.json`), sharing the whole inherited surface (dryRun/tier/model/sandbox/
  observe). The tier ladder (§3) is NOT built as code: the node's own deterministic gates already run inside its
  re-run; the gate agent adds only the two judgments a numeric gate can't — the reward-hack audit + soft quality.
- **Auto-adopt is just a setting.** Default stays human-adopt; auto-adopt is a config flip (the seam exists),
  NOT the elaborate measured-false-accept gate of §7.
- **Quality is judged by the human's perception, not automated metrics.** We do NOT benchmark the gate vs random
  / auto-measure false-accept as the mechanism (that path makes quality trash). The gate emits an evidence-cited
  rationale for the human — the real quality eye. The ledger's reopen/`regressedIn` stays a passive signal.
- **Drop-back feedback (the answered question): coach against the fixer's OWN goals, never hand it the answer
  key.** On REJECT the fresh fixer gets: the prior diff ("tried, rejected"), a coarse failure CATEGORY
  (`reward-hack | band-aid | didnt-reach-root | regressed-elsewhere`), a diversification steer, and ground-truths
  — but NEVER the gate's rubric/criteria (that teaches to the test; optimizing against the monitor teaches
  *hiding*, per OpenAI CoT-monitoring). Rejection-as-context ≠ optimizing the fixer against the gate.

### Shipped (branch `feat/triage-live-overlord`)
- `.claude/skills/piflow-gate/SKILL.md` — the gate playbook (3 checks · refute-by-default reward-hack audit ·
  drop-back packet · uncertainty ⇒ reject · human is the quality eye). Registered in `DEFAULT_SKILLS` + bundle.
- `packages/core/src/optimize/substrate/gate.ts` — `buildGatePrompt` + `runSubstrateGate` + fail-closed
  `parseGateVerdict`. 13 tests, parse teeth mutation-proven.
- `fix.ts` routing on one proved candidate: numeric oracle → `evaluateGate` (unchanged); else `optimize.judge`
  present → the gate agent (accept ⇒ staged for human; reject ⇒ `verifying→open` + drop-back packet); else →
  `evaluateGate` stage-for-human. New `opts.gate` seam; soft-path tests incl. the reject/drop-back path
  (routing mutation-proven).

### Still open (build / iterate)
- Ration the rerun by severity (today `prove` still runs once per candidate) — lane D's cost law.
- Pass a real unified diff to the gate (v1 lets it inspect `candidateRef` directly).
- The outer loop (`runOptimizeLoop`) consuming the drop-back packet to dispatch a FRESH, diversified fixer +
  the bounded-retry / circuit-breaker / tested give-up path (§8).
- prove-rerun provider → local when the parent recorded none.
- Live-prove on `flaky-cottage`.

## 1. The gap we are closing

The substrate loop today is `triage → fix → gate → stage → adopt(human)` (`optimize/substrate/{judge,fix}.ts`).
The GATE is `evaluateGate` (`optimize/gate.ts`) — **pure arithmetic**: accept iff `editsApplied≥1 AND
candidate_score > base_score`, folded over the SHARED numeric `.graded` keys of the parent vs the prove-rerun
child (`foldGradedDelta`). Its load-bearing law: **"score unmeasurable → cannot outcome-gate → route to human;
NEVER judge-gated auto-accept."**

The gap: a node like `w0-classify` has **soft criteria (`optimize.judge`) but NO numeric oracle** (`graded:{}`).
So the numeric gate can only ever say "unmeasurable → human," and the prove-rerun burns a full node
re-execution to produce an artifact nothing grades. **w0-classify sits in a bucket the loop has no gate for.**

## 2. The reframe the research forced (read this first)

Four findings recurred across independent lanes and change the design's center of gravity:

1. **PLAUSIBLE ≠ CORRECT, quantified.** Google's agentic APR ("Passerine") on human-reported bugs: 25.6%
   plausible (patch passes the bug's own test) but only 17.9% correct (semantically matches the human fix).
   SWE-bench "resolved" agent patches: 7.8% actually fail the developer suite, 29.6% behaviorally diverge from
   ground truth — a ~6pt inflation from **test-oracle weakness alone**. Our reward-hacking fear is this,
   measured. A gate must judge **correctness (mechanism)**, not **plausibility (passed the shown check)**.
2. **An ungrounded LLM judge is coin-flip-grade.** OpenHands' critic scored **AUC 0.45–0.48 (below random)**
   on production until it was grounded on real merge/survival signals (0.58–0.69). Most published overfitting
   detectors **lose to random-accept in 71–96% of realistic cases** (Williams 2026). ⇒ we cannot trust the
   gate's self-consistent reasoning; it must be **benchmarked against random** and **grounded on a real
   outcome signal** before we believe its numbers.
3. **False-REJECT is as dangerous as false-accept.** An over-strict gate silently collapses the accepted-fix
   rate toward zero — **indistinguishable from "no fixer available"** (PRISM). This is the SAME failure we
   already hit: the deep-tier fixer converged to 0 edits (memory `optimize-fixer-tier-finding`). It is also
   exactly the user's WORST FEAR wearing a disguise: "the fixer is too dumb to find the root" and "the gate is
   too strict to pass a real fix" look identical unless we **track candidates-killed**, not just accepted.
4. **Never auto-land is the universal industrial posture.** SapFix, Getafix, Infer/Zoncolan, Tricorder,
   Copilot Autofix, CodeGuru/Q — every mature system PROPOSES, a human LANDS. ⇒ our staged→human-adopt default
   is correct; **auto-adopt stays a setting that is OFF until measured** (§7).

## 3. The verdict ladder (cheap → expensive, fail-fast, rationed)

Replace today's single binary numeric gate with a **tiered ladder**. Each tier is cheaper than the next and
can DISCARD (or route to human) before the expensive tiers are paid for. This is the test-pyramid / Invalidator
/ BRT-proxy pattern, adapted.

| Tier | What runs | Cost | Discards / routes when |
|---|---|---|---|
| **0 · Contract-invariants** | deterministic, no execution: edits applied? harness still compiles/parses? structural invariants intact (output schema, required tool-calls declared, `io.checks` still present, **oracle files untouched**)? | ~free | fails structurally ⇒ discard, never spend a rerun |
| **1 · Static reward-hack audit** | the independent gate-agent reads the DIFF + the fixer's self-report + the ORIGINAL failing artifact/trace — **no rerun**. Refute-by-default: is this a root-cause harness change, or a symptom-silencer / teaching-to-the-test / hardcoded answer? | 1 cheap LLM turn | obvious hack ⇒ discard before paying for a rerun |
| **2 · The rerun** | re-execute the node against the candidate (`spawnChildRun`). **RATIONED by severity × confidence-the-diff-touches-the-failing-path** (§5). For nodes WITH a numeric oracle, the existing `evaluateGate` runs here (keep it — deterministic, drift-proof). | 1 full node run (our costliest op) | numeric regression ⇒ discard |
| **3 · Gate-agent quality judgment** | the gate-agent judges the NEW artifact against the criteria fixture (resolved live) + gold + **synthesized held-out probes** (§6), evidence-anchored, generative trace. | 1 LLM judge turn | REJECT ⇒ drop back; near-boundary ⇒ ONE confirmatory rerun |
| **Human · Adopt** | the staged manifest; default human, auto-adopt is a setting (§7). | human | — |

The numeric gate is **not replaced — it's Tier 2 for oracle nodes.** The gate-agent is the **new Tier 1 + Tier 3
for soft nodes.** Routing is derived from config (shared graded keys present → numeric; else `optimize.judge`
present → gate-agent; else → skip rerun, straight to human) — this subsumes the old "rerun-verifiable flag" idea.

## 4. The independent gate-agent (a third Base Agent child)

Structurally a sibling of `judge.ts`/`fix.ts` — spawned through `runBaseAgent` (`optimize/substrate/agent.ts`)
with `inheritedAgentOpts`, its own skill (a new `piflow-gate` playbook), a **fresh/blind context** separate from
the fixer. Its three checks (the user's own decomposition, now research-grounded):

1. **Read the whole board** — the rerun output + everything the fixer left (its diff + its written "how I
   fixed it" account). *(check-1)*
2. **Reward-hack audit, refute-by-default** — argue FIRST that the fix is a hack, then test whether that
   argument survives the evidence. The fixer's self-report is a **CLAIM cross-checked against the diff + output,
   never accepted as evidence** (CoT is unfaithful; OpenAI CoT-monitoring). *(check-2)*
3. **Quality — did it ACTUALLY fix it** — judge the mechanism step-by-step (PRM, not outcome-only), against
   the criteria + gold + held-out probes. If not → drop back to a FRESH fixer. *(check-3)*

Design rules (from the verifier lane):
- **Evidence-anchored, locked rubric (RULERS).** Every criterion cites a diff-line or output-excerpt; **no bare
  verdicts.** The rubric is versioned.
- **Generative verification trace (ThinkPRM).** The gate GENERATES its reasoning; that trace IS the artifact
  staged for the human — not a scalar.
- **Blindness + Goodhart fence.** The gate may see criteria/gold (it's a judge); the FIXER never does. The
  gate's rubric is oracle-like and must NOT leak back to the fixer (§5 drop-back).
- **Self-preference guard.** If fixer and gate share a base model family, a fluent diff may just be
  low-perplexity, not correct — the rubric's evidence requirement is the antidote.

## 5. Rationing the rerun (the cost law)

The rerun is a **full pi-agent execution — our single most expensive operation.** Standard CI says "reruns are
cents, just rerun more" (TUM); **our economics invert that.** So:

- **Only severe issues earn a rerun.** Gate on `severity (from triage) × confidence the diff plausibly touches
  the failing behavior`. Below threshold → decide on Tier 0/1 evidence alone, log-and-route, no rerun.
- **Default to ONE rerun.** A confirmatory SECOND rerun is spent ONLY when the verdict sits near a
  promote/demote boundary where non-determinism could flip it — never blanket N-of-M.
- **Tier 0/1 happen with no execution at all** — much verification is a diff read, not a re-run. This is the
  concrete mechanism behind "don't default to rerun."

## 6. The contract, resolved (don't be naive)

The user's instinct — "real problems are hard to define; we don't need everything written IN the issue" — is
**correct and the research backs it.** The naive move (triage hand-authors a crisp "what fixed means" acceptance
contract) reproduces the founding mistake of the overfitting literature: **judging against the same single
sample used to name the issue (train-set = eval-set).** Instead:

- Triage keeps naming the defect (+ severity, which now drives §5). Unchanged.
- The fixer writes its "how I fixed it" account + **pre-registers a mechanism signal** (what will show the fix
  bound). A mechanism claim, not an acceptance criterion.
- **The gate SYNTHESIZES its own held-out probes** from the criteria fixture at gate time (FixCheck / RGT /
  differential-testing), and judges **multi-probe** — never on the single triage sample. A perturbed/held-out
  variant (IPT) catches teaching-to-the-test: a genuine fix is invariant under a logically-equivalent probe, a
  shortcut is not.
- ⇒ the "verification contract" is **COMPOSED at gate time** (defect + live criteria + synthesized probes +
  fixer's mechanism signal), not pre-written. The issue stays lean; the hard judgment lives in the gate, where
  it belongs. **This is the answer to the contract question: don't write it down; synthesize it.**

## 7. The quality fear — instrument it, don't assume it away

The worst fear is a fixer too weak for a hard root cause (game-omni-class). The research says the gate can MASK
this, so we make it observable:

- **Track false-REJECT (candidates killed) alongside false-accept.** "N candidates killed for issue X" is the
  signal that the FIXER or the issue framing is the problem — not that no fix exists.
- **Ground the gate on a real outcome signal we ALREADY record.** The issue lifecycle's `resolved → regressed`
  reopen (with `regressedIn`, `issues.ts`) means a fix the gate accepted later broke = a measured **false
  accept**. So the ledger itself is the grounding signal OpenHands/others say a critic needs.
- **Benchmark the gate against random-accept** over our own staged-fix history before trusting it.
- **Auto-adopt is a setting, OFF by default**, gated on: measured false-accept rate below threshold AND beats
  random. This is the "bypass permissions" analogy — the seam and the spacing exist now; the switch flips only
  once earned.

## 8. Drop-back, retries, escalation

- **Drop-back = a FRESH fixer with a DIFFERENT strategy, never a same-agent conversation** and never the same
  approach repeated (self-repair research: diversify beats re-repair). Pass the prior attempt's diff + "failed,
  try another approach" as CONTEXT so it doesn't repeat — but **NOT the gate's rubric** (that teaches to the
  gate; keep the Goodhart fence). Passing rejection as *context* ≠ optimizing the fixer *against* the gate
  signal — the latter is forbidden (OpenAI CoT-monitoring: it teaches hiding, not fixing).
- **Bounded by a TRIPLE independent cap** — attempts (~3–4, empirical diminishing returns), token/cost, and
  wall-time (mini-SWE-agent). Past the per-issue bound → **keep the BEST candidate, hand to human** (SapFix),
  never a silent drop.
- **Two-level circuit breaker.** Per-issue attempt bound (above) + a coarser **system-wide** breaker: N
  consecutive gate-rejects across issues/nodes ⇒ an ARCHITECTURE problem (fixer too weak / issue framing
  wrong) ⇒ halt the loop, escalate. This is the "loops of loops to fix this loop."
- **TEST the give-up path.** OpenHands shipped its exhaust-retries→escalate path BROKEN (it hung). The failure
  path is the least-exercised and silently rots — it gets its own dedicated test.

## 9. Mapping to the code (what actually changes)

- **NEW `optimize/substrate/gate-agent.ts`** — `runSubstrateGate(childRunDir, nodeId, opts)`, a 3rd Base Agent
  child (mirrors `judge.ts`): build a gate prompt (issue + live criteria + candidate artifact + fixer diff/
  account + synthesized probes) → spawn blind via `runBaseAgent` → parse a structured verdict + rationale.
- **`fix.ts` — replace the binary gate with the Tier ladder + config-routing** (numeric vs agent vs skip). The
  `decision: staged|discarded` fold stays; a gate-agent REJECT walks the issue back `verifying → open` (the
  edge already exists); ACCEPT stays `verifying` for human adopt.
- **`fix.ts` prove-rerun — ration by severity** (§5) and **thread provider → local** (the deferred
  inmemory→local one-liner; the child must actually run to produce an artifact the gate judges).
- **`issues.ts` — the reopen/`regressedIn` lifecycle IS the grounding signal** (§7). Add false-reject
  accounting (candidates-killed) to the manifest/telemetry.
- **auto-adopt seam** — a setting, default OFF (§7); the manifest already separates stage from adopt.
- **`piflow-gate` skill** — authored via the `agentic-prompt-design` bar (evidence-anchored rubric,
  refute-by-default, generative trace, self-report-is-a-claim, multi-probe). Twin of `piflow-triage`/
  `piflow-fixer`.
- **Tests incl. the give-up path** (test-discipline; mutation-checked where logic).

## 10. What NOT to build (grounded anti-patterns)

- ❌ A bespoke correctness CLASSIFIER fine-tuned on our small fix corpus → dataset-overfits (Yang 2023). ✅ a
  general LLM gate-agent + deterministic pre-gate + multi-probe.
- ❌ Judge on the single triage/gold sample → the founding overfitting mistake. ✅ synthesized held-out probes.
- ❌ Encode diff-similarity ("correct patches look like the original") as a correctness signal → empirically
  false on complex patches.
- ❌ Feed the gate verdict back as a fixer OPTIMIZATION target → teaches hidden misbehavior (OpenAI). ✅ pass
  rejection as context to a fresh attempt only.
- ❌ Trust one ungrounded verdict → coin-flip. ✅ benchmark vs random + ground on the reopen signal.
- ❌ Leave the give-up path untested; erode the human-adopt backstop; auto-adopt before measuring.

## 11. Open questions (genuinely unresolved — for the build/iterate phase)

- **Probe synthesis fidelity for soft nodes** — can the gate reliably synthesize *good* held-out probes from a
  prose criteria fixture, or does that need a small per-node probe seed? (Start: gate-synthesized, measure.)
- **"Confidence the diff touches the failing path"** for a HARNESS edit (prompt/skill/data), not code — what's
  the cheap estimator? (Start: severity-only rationing; add confidence later.)
- **Can Tier-1 alone gate a low-severity fix** (no rerun at all), or is a rerun always required for an ACCEPT?
- **The reward-hack audit rubric** — the concrete, locked criteria list for "hack vs root-cause" on a harness
  edit.

## Sources (by lane)

- **APR / overfitting:** Smith FSE'15 (held-out) `10.1145/2786805.2786825` · DiffTGen ISSTA'17
  `10.1145/3092703.3092718` · RGT EMSE'21 `10.1007/s10664-020-09920-w` · Invalidator TSE'23 (arXiv 2301.01113)
  · FixCheck ICST'24 · PRISM OOPSLA'25 `10.1145/3763170` · Petke FSE'24 / Williams arXiv 2603.11262 (random
  baseline) · PatchDiff/SWE-bench-correctness ICSE'26 · Getafix.
- **Industrial & agentic:** SapFix ICSE-SEIP'19 · Getafix OOPSLA'19 · Infer/Zoncolan (CACM) · Tricorder
  ICSE'15 · Passerine arXiv 2501.07531 · BRT/EPR arXiv 2502.01821 · Copilot Autofix · CodeGuru→Q · SWE-agent
  arXiv 2405.15793 / mini-swe-agent caps · OpenHands "Learning to Verify" (ungrounded-critic AUC) + issues
  #8706/#5031 · Devin/SWE-bench · Aider · Cursor auto-review/approval-agents.
- **Independent verifier / anti-reward-hacking:** self-preference arXiv 2410.21819 · judge-bias taxonomy
  2410.02736 · Debate 1805.00899 / Brown-Cohen ICML'24 · PRM survey 2510.08049 · generative verifiers
  2408.15240 / ThinkPRM 2504.16828 · RULERS 2601.08654 · spec-gaming 2605.02269 + IPT · reward-ensembles
  2312.09244 · CoT unfaithfulness 2305.04388 + OpenAI CoT-monitoring.
- **Rationing / retry-escalation:** RTS/TIA ISSTA'15 · Meta predictive test selection (arXiv 1810.05286) ·
  risk-based testing (RPN) · test pyramid (Fowler) · flaky-cost TUM · CANNIER EMSE'23 · Invalidator/xTestCluster
  · SapFix human gate · "Is Three the Magic Number?" repair-budget · "Self-Repair Silver Bullet?" 2306.09896 ·
  circuit breaker (Nygard/AWS).

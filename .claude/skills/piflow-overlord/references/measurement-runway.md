# Overlord reference — the measurement RUNWAY (prepare it before the loop)

The optimization LOOP (triage → fix → adopt) is a PROCESS. It runs on a RUNWAY: the per-node MEASUREMENT
system it optimizes against. Prepare + verify the runway BEFORE the automated loop starts — because once it
starts everything is automated, and the loop can only ever be as good as the measures it reads. This is
phase 0 of every optimization pass, and the overlord OWNS it. It is NOT optional setup: **runway maturity
determines a large part of optimization quality — one of the most important things.**

**The runway is part of the OPTIMIZE SUBSTRATE — a system apart from the normal workflow.** Everything in this
file constructs the *optimization* system, never the run. The substrate reads a FINISHED run out-of-band and
grades it; it does not gate, block, or alter that run. That independence is exactly what the word "substrate"
names — the measurement layer sits BESIDE the workflow, never inside it. So do not reach for any workflow-runtime
machinery here: the runtime **profile-stamped gates** (`template/profiles/<name>.json` `execution`/`agentic`
gates that block or elide nodes DURING a run) are a DIFFERENT system with a different job, and a runway measure
is never one of them (§"How the runway maps to the shipped mechanism"). Keep the two apart or the runway rots
back into the workflow it is meant to sit beneath.

## Why the runway is the leverage point
The loop pushes a node's output to score higher AGAINST ITS MEASURES — so the measures ARE the target.
- A MISSING measure → the loop is blind to that defect (can't tell better from worse → optimizes noise or plateaus).
- A REWARD-HACKABLE measure → the loop Goodharts toward it (e.g. a distribution gate that rewards a bland uniform level).
- A SILENTLY-SKIPPING measure → false-green: the loop "passes" a broken artifact.
Invest in the runway BEFORE tuning the loop; a better measure out-leverages a better loop.

## Two kinds of measure — BOTH required, BOTH feed triage/judge
The triage/judge agent (piflow-triage: MEASURE then JUDGE → issues) needs both, plugged in as inputs:
- **HARD measures (deterministic — the FLOOR).** Objective checks computed from the artifact by CODE:
  schema-compile, distribution/fill/cluster, feasibility/reachability, assertion-lint, count-floors, the
  fill-sentinel. These are the node's `optimize.measure` op[] (folded post-run into the substrate report
  `optimize/substrate/measure.<node>.json`, NOT the run's own `io.checks`). They give the judge OBJECTIVE,
  non-rubber-stampable signal — a weak model acts on closed-form numeric checks but rubber-stamps a
  relational/prose self-audit, so the invariant MUST be deterministic code, not prompt prose. Hard measures
  set the floor: feasible · valid · complete.
- **SOFT measures (model-graded — the QUALITY JUDGE ABOVE the floor).** The per-node criteria fixture /
  rubric (`node.json` `optimize.criteria`) applied by the blind judge. They score what code can't:
  faithfulness, fun, design quality, "would a senior ship this." NEVER let a hard floor arbitrate QUALITY — a
  level can pass every deterministic check and still be bland; that is exactly what the soft judge is for.

Floor without judge → passes-but-bland. Judge without floor → ungrounded taste over a broken artifact. You
need both, layered.

## The pre-flight readiness check (run BEFORE starting the loop, per node)
Do NOT start the automated optimize loop for a node until its runway passes ALL four:
1. **COVERAGE** — the node has BOTH a hard-measure set AND a soft-measure (criteria) defined. A node with no
   measure is UN-OPTIMIZABLE; name it and author the measure first — that IS the work, not the loop.
2. **WIRING** — the measures are actually PLUGGED IN: the hard gates run and their verdicts reach triage; the
   criteria fixture is loaded by the judge. An authored-but-unwired measure is invisible to the loop.
3. **VALIDITY (test-the-measure)** — each measure FIRES and DISCRIMINATES: it FAILS when the artifact is
   wrong. A hard measure that silently SKIPS is worse than none. EVIDENCE: game-omni's blueprint
   schema-compile gate silently skipped on every run (ajv resolved draft-07 vs the schemas' draft-2020-12) →
   every blueprint shipped UN-validated while the gate reported pass. A soft rubric that rubber-stamps ("✓"
   with zero computation) is the same failure on the soft side. Confirm each measure is LIVE + DISCRIMINATING
   before trusting it — the same "a test is worthless unless it fails when the code is wrong" law.
4. **GROUNDING** — measures assert OBSERVABLE output only, never unobservable intent (a reward-hackable check
   corrupts the loop). Soft criteria anchor to observable evidence, not adjectives.

If any fails, the finding is "the runway isn't ready" → fix the MEASURE (author it · wire it · de-skip it),
NOT the node. That is legitimate optimization work; it just precedes the loop.

## How the runway maps to the shipped mechanism — the OPTIMIZE SUBSTRATE (no new machinery)
Both measures live in the node's own `node.json`, read straight off disk by the substrate, never routed through
a profile. The substrate is out-of-band and non-blocking by construction (§the framing above):
- **HARD** → the node's `optimize.measure` op[]. `runNodeMeasure` (`packages/core/src/optimize/substrate/
  measure.ts`) fires those ops PLUS the built-in trace detectors + run-digest anomalies, folding ONE
  deterministic report to `<runDir>/optimize/substrate/measure.<node>.json` — the graded axes triage reads.
  (An `optimize.measure` op reuses the op/check grammar but is NOT a workflow gate: it runs POST-run over the
  finished artifact and blocks nothing — parallel to, never part of, the run's own gates.)
- **SOFT** → the node-local `criteria.md` (+ its gold sample), referenced from `node.json` `optimize.criteria`
  (`optimize.judge` is a back-compat read alias). This is the blind judge's oracle — JUDGE-FACING only, never
  injected into the producing node's prompt.

So "prepare the runway" concretely = author each node's `optimize.measure` op[] + its `criteria.md`/gold IN
that node's `node.json`, and confirm triage reads their fold — NO profile edit, NO template-gate change, NO
touch to the run at all.

**Do NOT confuse this with the profile-stamped gates.** The profile system (`template/profiles/<name>.json`
`execution`/`agentic` gates) is the NORMAL WORKFLOW's runtime gating — a separate system that blocks or elides
nodes DURING a run (`production` runs the verify gates; `companion` elides them). It shares the op/check grammar
but does the opposite job: the profile gate governs the LIVE run, the substrate measure grades the FINISHED one
for the optimize loop. A measure is NEVER a profile gate and a profile NEVER carries a measure. If you find
yourself stamping a runway measure into a profile, you have crossed the two systems — stop and put it back in
`node.json`.

## The overlord procedure
1. Before any optimize pass, run the pre-flight per node in scope (COVERAGE · WIRING · VALIDITY · GROUNDING).
2. For any node that fails: HALT its loop; the owed work is a MEASURE fix (author / wire / de-skip), not a
   node fix. A loop on a bad runway wastes budget and can REGRESS quality (Goodhart) — prefer fixing the
   measure over starting a blind loop.
3. Only start the automated triage → fix → adopt loop for nodes whose runway passes.
4. Treat runway maturity as first-class status: report it, and grow it deliberately (a new gate, a sharper
   rubric) as the highest-leverage optimization investment. This composes with `optimization-ordering.md`:
   the runway must be ready at each node BEFORE that node's turn in the upstream-first order.

## Self-check
- [ ] Every node I'm about to optimize has BOTH a hard set and a soft (criteria) measure — or I named the gap.
- [ ] Each measure is wired into triage/judge (not authored-but-invisible).
- [ ] I test-the-measure: it FAILS on a wrong artifact (no silent skip, no rubber-stamp) before I trust it.
- [ ] No measure asserts unobservable intent (no reward-hackable check).
- [ ] I did not start a loop on a node whose runway is unready — I fixed the measure first.

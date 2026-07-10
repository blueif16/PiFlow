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
2. **WIRING** — the measures are actually PLUGGED IN, and triage can even RUN: the hard `optimize.measure` ops
   run and their verdicts reach triage; the soft `criteria.md` is referenced via the canonical
   `optimize.criteria` key and loaded by the judge; and `issues/` holds only a `.gitkeep` (a stray `README.md`
   or any non-issue `.md` makes `listIssues` throw and kills the triage command before any measure runs — see
   "The runway node-dir layout"). An authored-but-unwired measure is invisible to the loop; a mis-scaffolded
   `issues/` dir is worse — it's a crash.
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

### The runway node-dir layout — author EXACTLY this (the setup contract)
A node's runway is FOUR things under `template/nodes/<id>/`, and nothing else. Author each to this shape or the
loop breaks in a way `piflowctl extract` will NOT catch (extract compiles the DAG; it does not exercise the
optimize substrate):
1. **`node.json` → `optimize.measure`** — the HARD op[] (above). Fold nothing new; reuse the shipped signals +
   a thin deterministic op. **NEVER put a literal `{{arg.*}}` in ANY field of a measure op — not a path arg,
   and not even a `note`/comment string.** `runSubstrateMeasure` `resolveDeep`s the WHOLE op (every string,
   including `note`), and a token it can't resolve makes it DROP the entire op (recorded in `ops.rejected`, not
   run) — so a single `{{arg.lessonId}}` anywhere silently turns that node's floor DARK. And it WILL be
   unresolvable on most runs: run args are only persisted on runs created after arg-persistence shipped, so
   every historical `run.json` has `args:null`. The robust pattern (what the working nodes do): pass ONLY
   `{{RUN}}`/`{{WORKSPACE}}` to the op, and have the script DERIVE the lessonId in-script from the run's
   `.pi/run.json` artifact paths. Verify a measure op actually RUNS by executing `runSubstrateMeasure` against a
   real (argless) run and confirming `ops.runs`/`ops.checks` are non-empty for it — a script that fires when you
   call it directly proves nothing about whether the WIRED op runs during triage.
2. **`node.json` → `optimize.criteria`** — the SOFT pointer, a path to `criteria.md`. **Author the CANONICAL
   `optimize.criteria` key, NOT `optimize.judge`.** `optimize.judge` resolves only via a back-compat alias
   (`fix.ts`: `optimize?.criteria ?? optimize?.judge` — criteria wins); authoring the alias is drift, and a
   node that declares NEITHER makes `buildJudgePrompt` throw and kills the whole triage command.
3. **`criteria.md` (+ a gold sample)** — the soft oracle. JUDGE-FACING only, never injected into the node prompt.
4. **`memory.md`** — the Leg-A standing lessons (`memory-slices`).
5. **`issues/` — scaffold with a `.gitkeep` ONLY. NEVER a `README.md`, and NEVER any other `.md`.** This is the
   one that bites: issue files are `nodes/<id>/issues/<name>.md` **TOOL-MINTED by `piflowctl optimize triage`,
   never hand-authored**, and `listIssues` (`optimize/substrate/issues.ts`) is **fail-closed over every `.md`
   in the dir** — it `readdir().filter(f => f.endsWith('.md'))` and `parseIssueFile` THROWS
   `'issue file must open with a "---" frontmatter delimiter'` on any file lacking issue frontmatter. So a
   `README.md` (or any stray `.md`) makes `listIssues` throw → triage dies BEFORE the judge runs. A `.gitkeep`
   is invisible to the `.md` filter and keeps the empty dir in git. Do not put documentation, notes, or a
   template issue in `issues/` — that dir belongs to the tool.

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

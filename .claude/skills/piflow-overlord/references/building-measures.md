# Overlord reference — BUILDING a node's measures (the method that stocks the runway)

`measurement-runway.md` is the CHECK — it says a node cannot enter the optimize loop until its runway passes
COVERAGE · WIRING · VALIDITY · GROUNDING. **This file is the BUILD** — the reusable playbook a measurement
agent follows to author ANY node's hard + soft measures so that runway passes. Run it once per node, in
upstream-first order, BEFORE the loop touches that node. Producing a node's measures IS optimization work; it
is the highest-leverage work there is, because the loop can only ever climb toward the measures you write.

Read `measurement-runway.md` first (the two-measure model + the pre-flight gate); this file does not restate
it. Read the `piflow-triage` skill (the judge/triage agent your measures feed) so you author for its consumer.

---

## 0. The one principle everything below serves

**A node's measures judge the END PRODUCT, through the leverage this node has on it — never the node's own
tidiness.** For game-omni the end product is *a prompt → a truly robust, flexible, high-quality, playable game
in one pass*. Every node — even a first-node classifier that emits a small JSON — is measured by *how much its
output raises or forecloses the ceiling of that eventual game*. A measure that rewards "valid output" instead
of "output that leads to a great game" is measuring the wrong thing, and the loop will faithfully optimize the
wrong thing. Two consequences drive the whole method:

- **Hard measures own the FLOOR** (feasible · valid · complete · efficient) — deterministic, cheap, reused.
- **Soft measures own the CEILING** (would this produce a genuinely great end product?) — model-graded,
  aspirational, anti-Goodhart. Their bar is the eventual product's quality, not the node's format.

Floor and ceiling are different jobs. Never let a floor gate arbitrate quality (a valid classification can
still doom the game); never let the quality judge re-check the floor (that is the gate's job, cheaper and
surer). Build both, layered.

---

## PART A — THE SOFT-CRITERIA PHILOSOPHY (the heart — get this exactly right)

This is the most valuable and most abusable half. Encode these five laws as the BASIS of every soft measure —
both the checklist and the rubric. They are not style; they are what keeps the loop optimizing the real thing.

### Law 1 — Measure the PRODUCT, be SYSTEM-AGNOSTIC
A soft criterion judges the quality of the game / the end product **as a senior practitioner who has never seen
our pipeline would judge it.** It must read as a quality signal to that outsider — "this classification would
route to a game worth playing" — not to us. **Do NOT reward "valid JSON", "followed the schema", "used the
right field name", "wrote the artifact at the right path".** Those are the HARD floor's job. If a criterion
would still make sense after you deleted every mention of piflow, node, schema, and artifact, it is a real
quality criterion. If it evaporates without our vocabulary, it is a floor check wearing a rubric's clothes —
move it to the hard set or cut it.

### Law 2 — The bar is the HIGHEST, near-UNACHIEVABLE standard (aspirational, never a ceiling)
Anchor the top of the rubric to *what the best in the world would demand* of a truly robust, flexible,
exceptional end product — not to "what passes", not to "better than last run". The bar must sit ABOVE what the
current best run reaches, so there is ALWAYS headroom: a loop that can fully satisfy its rubric has nowhere left
to climb and plateaus at mediocrity. Reserve the top tier for genuine excellence and say so in the anchor ("do
not award by default"). A good sign you set it right: your own best real run does NOT clear the whole rubric,
and you can name which marks it fails and why (see the game-omni w1 fixture's "Calibration note" — the marks a
typical good run is *expected* to fail are the ones worth keeping).

### Law 3 — STRICTLY anti-Goodhart (the hard law)
> **Every soft criterion must key on OBSERVABLE evidence that the END PRODUCT is genuinely better, such that
> the ONLY way to raise the score is to make the real thing better. If a criterion can be fully satisfied while
> the end product is no better — a surrogate the loop can farm (a keyword present, a count hit, a field filled,
> a format matched, an adjective asserted, a step "mentioned") — it is WRONG. Rewrite it to key on the
> downstream quality it was standing in for. A measure is a proxy; the law is that the proxy's ceiling must be
> the real thing's ceiling.**

This is not caution, it is a documented failure. Under optimization, rubric gains concentrate in the *gameable*
criteria — **presence-based and completeness-based ones** ("mentions X", "has N items", "covers the topic") —
while real quality (correctness, conciseness, relevance, fun) silently *declines*, and a rubric-blind judge
then prefers the ORIGINAL over the "optimized" output (Reward Hacking in Rubric-Based RL, arXiv 2605.12474).
The exploit modes to design against, verbatim from that work: *partial satisfaction of a compound criterion,
treating implicit content as explicit, imprecise topical matching.* So:
- **One construct per criterion** — never "accurate AND well-written"; a low score then can't tell you which
  failed, and the compound is partially-satisfiable (game the easy half) (Autorubric, arXiv 2603.00077).
- **Prefer a criterion that keys on a DECISION/RELATION over one that keys on PRESENCE.** "Names a genuine
  fork whose two options change what the player optimizes" cannot be farmed; "mentions a hook" can.
- **Add negative criteria / red flags.** Positive-only rubrics invite the judge to charitably rate everything
  MET (sycophancy); an explicit failure signature per criterion counterbalances it (Autorubric).

### Law 4 — Anchor to QUOTABLE evidence, or it is a FAIL
A criterion PASSES only when the judge can point at the specific observable evidence — a quoted line of the
artifact, a cited number, a named beat — that earns it. No quote ⇒ no pass. This is the single biggest
reliability lever: evidence-anchored, quote-required scoring is what stops a judge hallucinating a pass, and
mechanically capping any high score that lacks its required evidence is what makes a high score *impossible*
without grounding (RULERS, arXiv 2601.08654; the Databricks "grading notes" result — brief per-item evidence
notes lifted judge↔human agreement to 93–96%). Write each anchor as *observable evidence*, never an adjective:
"excellent core loop" is unscorable; "one self-enclosed sentence naming a verb + goal + obstacle + fail that a
designer would call a game worth playing" is quotable.

### Law 5 — LEVERAGE, not locality (how a non-terminal node earns a product-quality bar)
A middle-of-the-pipeline node does not emit the game — so its soft measure judges its output *by the ceiling it
sets for everything downstream.* Ask, always: **"Read ONLY this node's output. Would a senior practitioner
predict it leads to a truly great end product — or has it already foreclosed greatness?"** A wrong routing
decision, a degenerate spec, an over-cut scope — each is invisible to a local "is this output valid" check and
fatal to the eventual product. The node's leverage IS its soft bar. Name the leverage explicitly before you
write a single criterion (Part C, step 2).

---

## PART B — THE TWO SOFT ARTIFACTS (checklist + criteria/rubric)

Author BOTH per node. They do different jobs and catch different failures.

**1. The CHECKLIST — the enumerable quality dimensions a complete great output covers.**
An inventory of *every dimension a genuinely great output of this node addresses* — used to catch OMISSIONS (the
"what full looks like" list, so a thin output has a concrete target it is failing against). 6–12 short,
one-construct lines. It is coverage, not grading: "did the output engage this dimension at all?" A dimension the
output silently skips is the cheapest, most common defect, and the checklist is what surfaces it. Derive it by
enumerating what the best-in-world output would necessarily cover (Part C, step 3).

**2. The CRITERIA / RUBRIC — the graded bar the judge applies.**
The scored specification, one row per criterion: `criterion · what PASS looks like (quotable) · failure
signature`. Rules that make it trustworthy:
- **Named criteria, decomposed** — never one holistic "goodness" score. Each row is ONE construct.
- **Tiers: Required vs Aspirational.** Required = the floor of *quality* above the hard floor (miss one ⇒ the
  output is not good, revise). Aspirational = the near-unachievable greatness marks (Law 2) that create
  permanent headroom. State the aggregation: e.g. "all Required must PASS; Aspirational marks are the
  discriminators that separate good from great."
- **Small scale.** Binary PASS/FAIL per criterion (or 0/1/2) beats a 1–10 — models cannot reliably distinguish
  73 from 76, and a fine scale collapses to a flat pile at one value (the "no anchors" tell). Get resolution
  from MORE binary criteria, not a finer scale.
- **Per-level anchors, observable.** Each PASS/FAIL is pinned to quotable evidence (Law 4).
- **Reasoning before verdict.** The judge cites evidence, THEN marks — never marks then rationalizes.
- **A gold exemplar IS the spec.** One authored, annotated example of a bar-clearing output — quote-mapped
  against every criterion — calibrates the judge's eye better than any amount of description. Author it for a
  case UNLIKE any live test input, so the judge calibrates on the bar and cannot pattern-match the answer. (See
  game-omni's `w1-design/criteria.md` "The Lampwright" — the model to imitate.)

**Where they live (game-omni today):** the checklist + criteria live in the per-node criteria fixture
(`.piflow/<wf>/template/nodes/<id>/criteria.md`, or the consolidated `.agents/skill-system-criteria.md` block
`Artifact · Purpose · Acceptance criteria · Red flags`); the gold sample sits beside them. Both are
JUDGE-FACING references — **NEVER injected into the producing node's own prompt** (seeing the bar teaches-to-
the-test and voids the clean-room signal the loop depends on).

---

## PART C — THE METHOD (do these in order, per node)

**Step 1 — Understand the node deeply FIRST (measures are only as good as this).**
Use the OKF understanding system (`okf-slices` / `piflowctl understand "<node>"`) and read the node's
`node.json` (contract · return schema · deps · hooks), its `prompt.md`, its SKILL, its `memory.md` (known
failure modes), and its `code-map.md`. Answer concretely, in writing: the node's CORE RESPONSIBILITY, its
EXPECTED OUTPUT, and its consumers. Do NOT from-scratch grep — return to the canonical slice.

**Step 2 — Name the node's LEVERAGE on the end product (Law 5).** One sentence: *if this node's output is
subtly wrong-but-valid, what does the eventual product lose?* This sentence is the seed of every soft
criterion. (For a classifier: "a wrong-but-valid archetype routes the whole build to the wrong template → a
fundamentally wrong game." That is the highest-leverage failure, so it becomes the top criterion.)

**Step 3 — Enumerate the checklist.** List every dimension a best-in-world output of this node would cover.
Pressure-test each against Law 1 (would an outsider recognize it as quality?) and Law 3 (is it a construct, not
a surrogate?). Cut floor checks (they go to Part D). 6–12 lines.

**Step 4 — Write the rubric.** For each checklist dimension that carries real quality (not every dimension
needs a graded row), write `criterion · PASS (quotable) · failure signature`, tag Required/Aspirational, key
each to a DECISION/RELATION over PRESENCE where possible (Law 3), and ground each in the node's SKILL / the
project's design research so it generalizes (a criterion that helps one input is a bug — state every criterion
as a RELATION, never a per-input constant). Set the top tier ABOVE the current best run (Law 2).

**Step 5 — Author the gold exemplar** (Part B) for an off-distribution case, annotated quote-by-quote.

**Step 6 — Run the anti-Goodhart self-check (Part E) on every criterion.** Rewrite any that fail.

**Step 7 — Specify HARD measures (Part D) + WIRING.** Say which reused signals cover the floor, which thin new
op[] wrapper (if any) is owed, and where each measure plugs into triage/judge.

**Step 8 — Verify against the runway pre-flight** (COVERAGE · WIRING · VALIDITY · GROUNDING). If a measure
can't be shown to FIRE and DISCRIMINATE on a wrong output, it is not ready.

---

## PART D — THE HARD-MEASURE APPROACH (reuse the shipped surface; do NOT reinvent)

Hard measures are deterministic, cheap, and **telemetry-grade concise** — the triage agent wants the *smallest*
signal that lets it spot obvious errors and confusions (loops, stalls, retries, blind-spots, waste). The
machinery already exists; your job is to WIRE existing signals, and propose (not build) at most a thin op[]
wrapper for the node-specific deterministic checks a schema can't encode.

**What already exists to REUSE (zero new SDK code) — the substrate measure surface.**
`runNodeMeasure` (`packages/core/src/optimize/substrate/measure.ts:111`) is the hard-measurement stage the
optimize substrate already runs per (run, node). It folds THREE sources into one deterministic report at
`<runDir>/optimize/substrate/measure.<node>.json`, which the judge/triage reads:
1. **The node's `optimize.measure` op[] checks** — `evaluateChecks` (`checks.ts`) over the node's declared gate
   ops. THIS is the seam where a node-specific deterministic lint plugs in (Part D "thin wrapper").
2. **The built-in TRACE detectors** — `analyzeTraceFile` (`substrate/trace-metrics.ts:277`) over the node's
   `.pi/nodes/<id>/events.jsonl`, yielding a `TraceMetricsReport` (`:79`): `thinkingStalls` (deliberation
   blocks ≥ threshold — the over-think / stall signal), `toolLoops` (byte-identical repeated `(tool,args)`),
   `tokenWaste`, `cacheMisses`, `truncatedLines`. These are the tracing-quality + easy-to-spot-confusion
   signals — reuse them as-is.
3. **The run DIGEST anomalies** — `projectRunDigest` (`observe/telemetry.ts:377`) → this node's `anomalies`
   (`AnomalyKind`, `telemetry.ts:41`): `failed · truncated · tool-loop · loop-score · context-pressure ·
   mega-think · slow · cost-spike · retries`, ranked worst-first. These are the efficiency + loop/stall/waste
   signals. `mega-think` (pure deliberation, zero tool calls) and `slow` (≥ 2× cross-run mean) directly catch
   over-think stalls; `tool-loop`/`loop-score` catch repeat loops; `cost-spike` catches token blow-ups.

**Also reusable, agent-facing, no new code:**
- `piflowctl telemetry <run> <node>` — per-node verdict · tokens in/out · ctx% · model/tool call counts · retry
  loops · anomalies · stop reason · the per-turn table (offset · duration · think-chars · tools). The
  efficiency + over-think read.
- `piflowctl trace <run> <node>` — the element tree: injected prompt + every read/edit in order · coverage · sha
  · **blind-spot rollup (advertised-but-unread)** · **re-reads (READ-ONCE violations)**. The tracing-quality +
  blind-spot read — deterministic, and often the sharpest node-specific hard signal (did it read the inputs its
  contract advertised? did it re-read and bloat?).
- `deriveStatus` (`observe/read.ts:62`) — verified-not-trusted status: a node that claims complete but is
  missing its declared artifact downgrades to `blocked`. The existence/fill floor, already computed.
- The node's `return` schema in `node.json` — the SDK already enforces field presence + enum types on the
  structured result. That is a free floor check; do not duplicate it.

**What is a THIN NEW WRAPPER (propose, config not code — a node's `optimize.measure` op[]).**
For the node-specific deterministic invariants a JSON schema can't express — e.g. "a field value must be a
member of a LIVE data-driven registry", "field A is consistent with field B per a fixed rule table", "a list
has ≥ N items" — author a small set of `run`+`writes` gate ops in the node's `node.json` `optimize.measure`.
`evaluateChecks` folds them into the same report; NO new SDK code is needed. Say honestly when a signal does
NOT exist yet and would be a new wrapper — never claim a function that isn't there.

**The hard/soft boundary (the line to hold):** if `==`, a schema, a registry-membership test, or a trace
detector can decide it, it is a HARD measure — do not pay a judge to check what code checks for free. The judge
is only for what code cannot reach: is the routing *right for this prompt*, is the loop *fun*, is the scope cut
*wise*. (Deterministic-first is also the reliability move — a weak judge acts on closed-form numbers and
rubber-stamps a prose self-audit, so keep the floor in code.)

---

## PART E — THE ANTI-GOODHART SELF-CHECK (run on every criterion before shipping)

For each soft criterion, answer all five. A "No" means rewrite it.
- [ ] **Gameable?** Can this be fully satisfied while the end product is NO better (a keyword, a count, a
  filled field, a matched format, an asserted adjective)? If yes → it keys on a surrogate; rewrite to key on the
  downstream quality it stands for. (The usual culprits: presence/completeness/"mentions" criteria.)
- [ ] **System-agnostic?** Would a senior practitioner who never saw our pipeline recognize this as a quality
  signal? If it needs our vocabulary (schema/field/artifact) to make sense → it is a floor check; move it.
- [ ] **Observable + quotable?** Can the judge point at a specific line/number/beat that earns the pass? If it
  rests on unstated intent or an adjective → re-anchor to observable evidence.
- [ ] **One construct?** Does it measure exactly one thing? If it conjoins two ("A and B") → split it.
- [ ] **Aspirational, not a ceiling?** Is the top tier above what the current best run reaches, with headroom to
  climb? If the best run already clears it → raise the bar or make it a Required floor, not a discriminator.
And once, over the whole set: **would optimizing every criterion to PASS actually produce a better end product,
or a hollow one that games the marks?** If you cannot answer yes with conviction, a criterion is a proxy —
find it. (The honest external test of the whole set: a rubric-BLIND judge, ideally a different model family,
should prefer the high-rubric output over a low-rubric one. If it prefers the low one, the rubric is hacked.)

---

## PART F — HOW THE MEASURES PLUG INTO TRIAGE / JUDGE

The `piflow-triage` agent (MEASURE → JUDGE → issues) reads BOTH fronts together (its Step 0):
- **HARD** → the substrate `measure.<node>.json` (Part D): the op[] checks + trace detectors + digest anomalies
  — the graded/structural axes triage cites as its "detector + evidence line".
- **SOFT** → the criteria fixture + gold sample (Part B) — the JUDGING references the blind judge applies. These
  are references ONLY; they are never injected into the producing node's prompt.

Your measures are DONE when: triage can name a real defect from each front and cite its evidence line; the hard
report FIRES on a wrong artifact (no silent skip); the soft rubric DISCRIMINATES (a wrong artifact fails a
named criterion with a quote, a right one passes) and does NOT rubber-stamp. That is the runway's VALIDITY
check — apply it here, at authoring time, not after the loop has wasted budget on a blind measure.

---

## Worked example
The full worked application of this method — every step, both artifacts, the reuse/wrapper split — is
`game-omni/docs/measures/w0-measures.md` (w0-classify). Read it as the exemplar of the output this method
produces.

## Self-check (before returning a node's measures)
- [ ] I understood the node via the OKF slice, and named its LEVERAGE on the end product in one sentence.
- [ ] I authored BOTH a checklist (coverage) AND a criteria/rubric (graded, tiered, quotable) + a gold exemplar.
- [ ] Every soft criterion passed the Part E anti-Goodhart self-check (product-keyed · system-agnostic ·
  quotable · one construct · aspirational).
- [ ] The top tier sits ABOVE the current best run — I named which marks a good run is expected to fail.
- [ ] Hard measures REUSE the shipped surface (trace detectors + digest anomalies + status + trace blind-spots);
  any node-specific deterministic check is a thin `optimize.measure` op[] I PROPOSED, not a function I invented.
- [ ] I stated the WIRING (which front each measure reaches triage through) and showed each measure FIRES +
  DISCRIMINATES on a wrong output.

## Provenance (the research this method folds in)
- **Reward Hacking in Rubric-Based RL** — arXiv 2605.12474 — the anti-Goodhart law: unspecified failure modes →
  gains concentrate in presence/completeness criteria while real quality declines; validate against a
  rubric-free cross-family judge.
- **RULERS: Locked Rubrics & Evidence-Anchored Scoring** — arXiv 2601.08654 — evidence-anchored, quote-required
  scoring; mechanically cap a high score that lacks its evidence; anti-halo/boundary checks.
- **Autorubric** — arXiv 2603.00077 — one construct per criterion (unidimensionality); construct alignment
  (operationalize the real thing, not proxies that may not correlate); negative criteria counter sycophancy.
- **Rubrics as an Attack Surface (RIPD)** — arXiv 2602.13576 — benchmark-preserving rubric edits can silently
  drift what a judge prioritizes → version rubrics, validate on a held-out set, treat a rubric edit as a
  bisectable regression.
- **Databricks Grading Notes** (2024) — brief per-item evidence notes lift judge↔human agreement to 93–96%;
  brevity is a feature (over-specifying forces a path).
- **FutureAGI / Deepchecks / QASkills LLM-judge guides** (2026) — anchored levels double judge↔human kappa
  (~0.4 → ~0.78); reserve the top tier for excellence ("do not award by default"); a flat score distribution is
  the "no anchors" tell; small scales; reasoning-before-verdict; deterministic checks for what `==` can decide.

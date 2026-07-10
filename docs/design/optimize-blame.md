# Run-level BLAME — the attribution layer over the per-node optimize loop

Designed 2026-07-09/10 (sync + research pass). Grounded in code as of `main@7b97c14` and in:
`docs/specs/optimize-substrate-plan.md` (the shipped per-node engine, M-numbering),
`docs/design/optimize-issue-lifecycle-redesign.md` (WS-numbering), `docs/design/optimize-verification-loop.md`,
`docs/research/memory/piflow-memory-v1.5.md` §7, `docs/ARCHITECTURE.md` §6, and the overlord references
(`measurement-runway.md`, `optimization-ordering.md`). External grounding is cited inline (§12).

## 0. Why — the per-node loop is complete but blind above the node

The substrate loop (`optimize triage → fix → verify → adopt --node`) is shipped end-to-end: issues are
tool-minted per node, a fix is a git candidate (`{baseSha, candidateSha}` on a throwaway branch), prove is a
single-node replay, adopt is a serialized cherry-pick. What is missing is everything ABOVE the node:

- **Attribution.** Node triage reads only that node's own measures. An end-to-end defect that *surfaces* at a
  downstream node gets mis-filed as that node's local defect — the input-cause trap the ordering reference
  handles only as overlord procedure today.
- **Scheduling.** `optimization-ordering.md` tells the overlord to hand-sequence upstream-first; its own
  build-status note says the orchestrator verb is "to FILE, never to fake." This doc files it.
- **Adopt at scale.** With many issues staged across nodes, batch cherry-pick has no staleness policy beyond
  "conflict ⇒ skip" — textual drift is caught, semantic drift (proven against a base that moved) is not.

BLAME is the run-level triage: measure the FINISHED RUN against **template-level** hard+soft criteria,
attribute each end-to-end defect to the node that caused it, and dispatch that attribution to the per-node
loops. It is `piflow-memory-v1.5.md` §7's `triage(scores, digest, priorRuns+memory) → Defect[]
{node, bucket, evidence, confidence}` re-materialized on the substrate engine — and `ARCHITECTURE.md` §6's
outer-loop credit assignment ("which node owns this failure") made a verb.

**The fractal thesis.** Same grammar, one level up. A node's runway is `optimize.measure` (hard) +
`criteria.md` (soft) → triage → issue files. The run's runway is the template-level twin → blame → blame
files. Chain of responsibility, one markdown boundary object per seam:

> run-triage **BLAMES** → node-triage **NAMES** → fixer **SOLVES**

## 1. Decisions (locked in the 2026-07-09 sync)

1. **Template-level runway, same syntax as the node level**: `meta.json` `optimize.{measure, criteria}` +
   template-root `criteria.md` (+ gold sample) + template-root `memory.md`. Read straight off disk by the
   substrate, never loaded onto the runtime spec — the exact precedent of `node.schema.ts:385`. ⚠
   `meta.schema.ts` is `additionalProperties:false`, so this is an explicit schema extension (WS-B0), not a
   free-rider key. The HARD slot is **expected-sparse** at run level and the per-node responsibility roster
   is **auto-composed from each `node.json`**, never hand-synced (§2 — user call 2026-07-10).
2. **Blame files are per-run dispatch artifacts**: `<runDir>/optimize/blame/<node>.md`. Born in the run dir —
   born archived, immutable, no relocation step ever. They are **NOT lifecycle objects**: no status machine,
   no `sig`/dedup, no reopen (reconciliation vs the issue ledger: §7, §9). And they are **PROSE, not schema**
   — the consumer is the node-triage LLM; the only machine-read surface is the run summary's fenced tail (§3).
3. **The node-loop delta is ONE seam**: node triage ingests the blame file as one extra context section.
   Nothing else in triage/fix/verify/adopt changes.
4. **Cross-run blame recurrence rides template-root `memory.md`** via memorize + a recurrence read — no new
   store. The node-issue ledger's hash recurrence is a different grain and stays untouched (§7).
5. **`piflowctl optimize blame <run>`** is a first-class verb, sibling of `triage`, with a PLAIN argument:
   `<run>` accepts a run dir path OR a run id/name (resolved through the product's runs, the same lookup the
   other observe verbs ride); idempotent (re-running rewrites that run's `blame/` dir); `--latest` resolves
   the newest run.
6. **Two ordering modes** (§5), selected mechanically from the blame output, overridable by flag.
7. **Adopt gains train semantics** (§6): blame-ordered landing, a staleness policy, bounce-to-open, branch GC.
8. A template-side "current blame" pointer file is **deferred** — "latest" is resolve-at-read (`--latest`);
   add a pointer only when a skill needs a hardcodable path.

## 2. The template-level runway (phase 0 — same syntax as a node, different weight distribution)

One grammar, two levels: the template's runway uses the EXACT `optimize.{measure, criteria}` structure a node
uses. But the weight flips at run level:

- **HARD — the slot exists, and is EXPECTED-SPARSE.** `meta.json` `optimize.measure` op[] over the run's
  FINAL artifact, folded to `<runDir>/optimize/blame/measure.json` (same op/check grammar; POST-run; blocks
  nothing — never a profile gate). Author one only when the product has a REAL end-to-end invariant (an e2e
  build/smoke of the final artifact); most templates will leave it empty — a run-level deterministic check is
  usually too general to surface anything real, and forcing one manufactures noise. The run's mechanical
  floor does NOT depend on this slot: the evidence pack (§4) already aggregates every node's OWN hard report
  plus the digest — the node-level floors ARE the run-level floor.
- **SOFT — the load-bearing half.** Template-root `criteria.md` + gold, referenced from `meta.json`
  `optimize.criteria`: the FINAL-ARTIFACT bar, in prose — final artifacts vary the most across workflows, so
  this is where the per-template variety lives, and it is where the blame guidance lives ("judge the end
  product a user actually receives; attribute what falls short"). JUDGE-facing only — never injected into any
  node's runtime prompt, never shown to fixers (§11 Goodhart fence).
- **The responsibility roster is COMPOSED, never authored.** "What is each node responsible for" is the map
  the judge attributes against — and it is NOT hand-written into `criteria.md`. The blame verb auto-composes
  it at judge time from each node's OWN declarations (`node.json`: id · description · `contract` produces/
  owns, i.e. the same fields the DAG already compiles from), so editing a node updates the roster on the next
  pass with zero manual sync — resolve-at-read, the same pointer-not-copy law as the memory-leg join.
  `criteria.md` stays purely the final-artifact bar; the roster rides beside it in the judge context.
- **Pre-flight (adjusted for the weight flip)** — the measurement-runway gate applies with one amendment:
  COVERAGE at run level requires the SOFT criteria (+ gold); the hard op[] is OPTIONAL and its absence never
  halts the loop. WIRING · VALIDITY · GROUNDING apply to whatever exists — in particular the soft criteria
  must DISCRIMINATE (fail a known-bad final artifact), and a hard op that is authored must pass
  test-the-measure. "The runway isn't ready" remains a legitimate blame-pass verdict.

## 3. The blame file — a prose dispatch, not a schema

`<runDir>/optimize/blame/<node>.md`, one per blamed node. **Plain markdown, no frontmatter, no codec.** The
only consumers are the node's triage agent (an LLM) and a human — so the file is prose-first by design:
structure taxes a reasoning consumer, and the schema boundary belongs at the LAST parser, not on an
intermediate another model thinks over. What matters is that the judge TELLS the mistakes it saw viewing the
final artifact from the global standpoint, in the node's direction. Convention, not schema:

```markdown
# blame — <node> @ <run id>

<Prose, ~30–60 lines: what is wrong with the FINAL artifact, which part of that this node owns
and why, where the defect SURFACED vs where it originated, and what the propagated evidence
looks like. The run-level judge speaking to this node's triage. Attribution context, never fix
instructions. Evidence pointers (artifact paths · measure keys · failure-onset hops) cited
inline where each claim is made.>
```

The discipline that an earlier draft encoded as fields is JUDGE discipline — enforced by the blame prompt's
self-check (§4), not by a parser:
- every claim cites OPENABLE evidence inline (a path, a measure key, an onset hop). "The defect is visible in
  this node's output" alone FAILS — that is the manifestation trap (§12: AgentTrace, 47.4% of LLM
  attributions pick the surfacing node, not the root);
- blame the DECISION point over the execution point (§12: CAR — "the step that executes the harmful action is
  usually not the step that decided on it"); when causes are genuinely joint, say so in BOTH nodes' files,
  cross-referenced in prose — never force a single owner;
- recurrence context from `memory.md` is stated where relevant ("3rd consecutive generation");
- a defect the judge cannot attribute WITH evidence goes to the run summary as unattributed (an ARCH signal),
  never onto a node "to have an owner";
- blame files carry evidence and defect descriptions, NEVER the template `criteria.md` content — the same
  Goodhart fence as issues never carrying the gate rubric (`optimize-verification-loop.md` §8);
- downstream, a blame file is a **HYPOTHESIS, not an instruction**: the owning node's triage must corroborate
  it against node-local evidence before any issue exists, and may CONTEST it (§4.1).

**The run summary is the ONE parser boundary.** `<runDir>/optimize/blame/blame.md` — the run-level prose
summary (the one-glance surface for the overlord/human: the global verdict, unattributed defects, the mode
decision) ending in a small fenced JSON tail carrying the ONLY machine-read fields:

```json
{ "blamed": [{ "node": "...", "severity": "high", "observedAt": ["..."] }],
  "edges": [["owner", "observedAt"]], "unattributed": ["..."] }
```

— exactly what the scheduler (§5) and lane priority need, nothing more. Per-node blame files are NEVER
machine-parsed; nothing in the codebase reads them but the triage prompt assembly (verbatim inject) and eyes.

## 4. The verb — `piflowctl optimize blame <rundir>`

Pipeline (evidence-first, judge-second — the verdict-ladder rationing applied to attribution):

1. **Measure (mechanical, free).** Run the per-node substrate measures for every node missing a report
   (`runSubstrateMeasure` — idempotent), then the run-level hard fold (§2) → `blame/measure.json`. Blame is
   self-sufficient: it does not require a prior triage pass.
2. **Evidence pack (mechanical, free).** The run digest + failure-onset localization (the shipped
   `projectRunDigest` / file-flow onset walk, `telemetry.ts:250-291`) + the compiled DAG's data-flow edges.
   The judge CONSUMES the backward walk; it does not re-derive causality from vibes.
3. **Judge (model, blind).** Fresh out-of-band context; inputs = evidence pack + per-node measure reports +
   template `criteria.md`/gold + the AUTO-COMPOSED responsibility roster (§2) + template-root `memory.md`
   (recurrence context). Proposes attributions per §3's judge discipline. Judges artifacts and measures —
   never a node's self-narrated success (§12: judge-gaming; the overlord's "verify, don't trust" law applied
   to attribution).
4. **Verify round (model, one re-check).** A single-pass judge is measurably worse than judge+re-check (§12:
   RAFFLES). One round: for each proposed attribution, confirm the cited evidence actually supports the owner
   (open the artifact/measure/chain hop; manifestation-trap check; decision-vs-execution check). Drop or
   downgrade what fails; do NOT iterate further (rationing — replay is the real falsifier, §8).
5. **Write.** Prose blame files + the `blame.md` summary (prose + the fenced tail) + events. Idempotent
   rewrite of `blame/`.

Model routing: the judge/verify turns run on the strong judge tier (product-injected, same seam as the gate
agent); the measure steps are code.

### 4.1 The node-triage seam — blame is a hypothesis; ingest cautiously, dissent loudly

The consumer of a blame file is the node's triage agent, whose contract is the **piflow-triage skill**
(`.claude/skills/piflow-triage/SKILL.md` — recently hand-adjusted; WS-B4 reconciles with its CURRENT text,
never a blind overwrite). Today `buildJudgePrompt` supplies it: the hard measure report · the criteria/gold
judging references · the node's `memory.md` · the `<existing_issues>` ledger · a git-history instruction.
Blame arrives as exactly ONE more harness-supplied section, `<blame_context>`, and the skill gains the rules
for it:

- **Corroborate locally before minting.** An attribution passes through the skill's existing Step 1
  UNCHANGED: the issue exists only when detector · evidence line · mechanism sketch can be filled from
  NODE-LOCAL evidence (the blame's citations say where to look; the node's own artifact/measures must
  confirm what they claim). Run-level say-so is never a detector. Blame also NEVER bypasses the recurrence
  check (Step 2) or the `sig` discipline (Step 3) — a blame-sourced defect that matches a ledger entry is a
  REFERENCE/RE-SEEN like any other.
- **Dissent is a first-class output.** If node-local evidence contradicts — or simply fails to corroborate —
  an attribution, triage does NOT mint an issue to be agreeable: it reports the contest WITH the
  contradicting evidence, and that contest must leave an observable trace (recorded by the CLI beside the
  triage output and folded by blame-memorize into `memory.md`) so the NEXT blame pass re-attributes with the
  dissent in context — never a silent drop. This makes node triage the attribution's third check, by design:
  blame's own verify round (§4 step 4) → **node-local corroboration (here)** → the generation replay (§8).
- **The global standpoint rides the brief, not the rubric.** A corroborated blame-sourced issue fills the
  brief's existing "why it matters downstream" slot with the RUN-level defect + propagated evidence, so the
  fixer aims at the end-to-end outcome, not the node-local score alone; severity may be RAISED by run-level
  impact (the ADOPT rule — weight fix effort by contribution); and the issue defaults `verify: full` so the
  gate agent judges the fix, with the propagation run as the true global confirmation. The template
  `criteria.md` itself still never reaches an issue, a producer prompt, or a fixer.

## 5. The two ordering modes — and the mode is DERIVED, not guessed

Build the **blame graph** from the summary tail's `edges` (§3 — the one parsed surface): every attribution
with `owner ≠ observedAt` is an edge `owner → observedAt` over the blamed nodes (direction: fixes flow
downstream).

- **MODE T — TOPOLOGICAL (chains).** Any connected component with edges is scheduled upstream-first, exactly
  per `optimization-ordering.md`: fix the owner, adopt, **propagate** (`run --from <owner> --until <next>`),
  re-measure, and expect downstream attributions to DISSOLVE (mark superseded — they were input-caused).
- **MODE P — TRAIN (independent lanes).** Components with no edges (all blame node-local) run as parallel
  per-node lanes. Within a lane, issues are STRICTLY LINEAR in the shipped order (severity-desc,
  firstSeen-asc), and the lane BLOCKS on its own landing before starting its next issue — so within-node
  candidate N always branches from a HEAD containing N−1 (no same-node conflicts, prove-evidence never goes
  stale within a lane). Cross-lane landings interleave through the train (§6).
- Mixed runs get both: chains topological, independent components parallel beside them. `--mode topo|train`
  overrides. MODE P still owes the reconcile pass the ordering doc demands — which is simply the propagation
  run that opens the next generation (§8), so the obligation is discharged by construction, and it is LOGGED
  in `blame.md`, never silently skipped.

## 6. The adopt train — sustainable git at N issues

The shipped model (candidate = commit, adopt = serialized cherry-pick, conflict ⇒ abort+skip) is optimistic
concurrency with a safe-but-lossy resolution. The train adds queue semantics. Industry note (§12): merge
queues default to ALWAYS-revalidate when the base changes; path-disjointness skips are an opt-in optimization.
Our skip is principled — cross-node closures (`owns`/`readScope`) are *designed* disjoint — but it is an
explicit, logged policy, with generation-level re-blame as the backstop.

- **Single writer.** One train per live product root; landing order = blame order (upstream-first components,
  then severity within a node). Completion order ≠ landing order: a lane's green candidate WAITS while an
  earlier-ordered record is in flight (§12: bors `CompletedPendingMerge`).
- **Staleness policy per staged record at land time** (extends the lifecycle redesign's §2 "re-verify on base
  drift"; a pure function over `(baseSha, HEAD, changedPaths, closure)` — table-tested):

  | condition | action |
  |---|---|
  | `baseSha == HEAD` | land (cherry-pick) |
  | clean pick AND intervening commits disjoint from the node's include-closure | land; log the skip |
  | clean pick BUT closure overlaps | **re-prove first** (tier `rerun`: `spawnChildRun` + measure vs fresh base), then gate → land/bounce |
  | pick conflicts | **bounce** — never force |

- **Bounce = the existing back-edge.** `verifying → open`, with a dropback `{category: 'stale-base', steer:
  "the baseline moved under this fix — re-fix against current HEAD"}` threaded to the next attempt by the
  shipped retry loop. Matches merge-queue semantics: a bounced entry re-enters explicitly, never silently.
- **Branch GC** (today branches accumulate forever): on `resolved`, delete the throwaway branch — the landed
  cherry-pick sha stamped in the issue's attempt row is the durable record; a discarded candidate's branch is
  retired when its issue closes (escalation packets deliberately keep theirs).
- **No silent caps**: every skip, wait, re-prove, and bounce is written into the record's reason and the
  train's event stream.

## 7. Recurrence & memory — two grains, deliberately

The docs-recon flag is real and the answer is a split, not a winner:

- **ISSUE grain (shipped — untouched).** The ledger's identity recurrence: `sig`-derived id, hash-rematch →
  reopen → `regressed`, `firstSeen/lastSeen/attempts[]`. Mechanical, per-node, template-side, and deliberately
  self-contained from `memorize.ts` (`optimize-substrate-plan.md` §M2). BLAME does not touch it.
- **RUN/BLAME grain (new).** Blame files carry no identity and no ledger — their only cross-run trace is
  memory: after the blame pass (or at generation end), a **blame-memorize** step distills each attribution
  into a lesson block in **template-root `memory.md`** (run id + owner + defect + outcome-when-known). The
  NEXT blame judge reads those lessons and stamps `recurrence:` into fresh blame files. This fulfills
  v1.5 §7's "recurrence is the first real reader of Leg-A" at the run level — no new store, no scanner over
  old run dirs, and the issue ledger keeps its own grain.
- **Escalation.** The same attribution recurring ≥N generations — especially "blamed, fixed, defect persisted"
  (§8) — is an ARCH signal routed to the long-horizon seam (`runLongHorizon`, the redesign-next-workflow
  STOP), not another lane iteration.

## 8. The generation loop — and blame's falsifiability

```
generation N:
  piflowctl optimize blame <runN>            → blame files + summary (mode derived)
  schedule:                                   chains → MODE T · independents → MODE P
    per lane: triage(+blame context) → [fix → verify → train-land]*  (strictly linear)
  train drains → propagation run (--from the earliest adopted node)
  the propagation run IS generation N+1's baseline → re-blame → loop
stop: blame comes back empty (converged) · no measurable delta across a generation (stalled)
      · consecutive-exhausted breaker trips (architecture signal — escalate)
```

**Blame is a hypothesis the next generation tests.** Counterfactual replay is the strongest attribution
signal known (§12: AgenTracer, CAR) and this loop gets it free: if generation N fixed the blamed node and the
defect persists in N+1's baseline, the attribution was WRONG — that history lands in `memory.md` via
blame-memorize, the next judge must re-attribute with it in context, and a repeat is the ARCH escalation
above. Expectation-setting is part of the design: single-pass agent-level attribution lands ~50% in the
hardest published benchmark (§12: Who&When) — the loop, not the judge, is what makes blame reliable. This is
also why blame stays at NODE grain: step-level attribution is ~4× less reliable and we never promise it.

**Driver:** the primitives ship as verbs; the generation loop is OVERLORD-driven first (an addendum to the
overlord skill's on-ramp — it already owns the manual version of this loop), and a deterministic
`optimize run <templateDir>` driver is a follow-on (WS-B7), mirroring how `runOptimizeLoop` wrapped
`runFixGate` only after the single round was proven live.

## 9. Reconciliation notes (naming the near-collisions loudly)

- **Blame ≠ issue.** | | issue | blame | — durable template-side lifecycle work item with status machine +
  identity/dedup + attempts, vs. run-scoped immutable attribution dispatch with neither. A blame file never
  transitions; it is consumed and superseded by the next run's blame. Readers of the substrate plan should
  expect the DIFFERENCE, and the fence is structural: per-node blame files have no parser at all (only the
  summary's fenced tail is machine-read), so there is nothing to mistake for a lifecycle object.
- **Pareto multi-candidate fixing** (`optimize-verification-loop.md` SOTA item 2, deferred) is orthogonal: it
  proposes several candidates for ONE issue and gates a front; the train still receives exactly one winning
  candidate per issue. Lane linearity is unaffected.
- **The classic engine** (`scoreRun/triage/renderRouting` → HERMES-ROUTING.md, `--fix --binding`) is the
  lineage of this design and remains the binding-driven product path; BLAME supersedes HERMES-ROUTING for the
  substrate path. No shared state between the engines is introduced.
- **Verdict-ladder alignment**: blame's pipeline is the ladder's rationing applied to attribution — free
  mechanical tiers first (measure, digest, onset walk), one judged pass, one verify round, and replay reserved
  for the loop itself (§5 rerun-rationing logic, one level up).

## 10. Workstreams

| WS | what | acceptance (observable) |
|---|---|---|
| B0 | `metaSchema` `optimize` extension (mirrors `node.schema.ts:385` precedent) + template runway authoring contract (criteria.md/gold layout; hard slot optional per §2) + pre-flight extension to the overlord reference | `loadTemplate` green on a template carrying the block; pre-flight names run-level gaps on a template without SOFT criteria, and passes on a soft-only template (empty hard slot never halts) |
| B1 | run-level hard measure: `meta.json` ops + digest fold → `blame/measure.json` (expected-sparse — build the seam, not a measure zoo) | deterministic; unit + mutation tests on the fold (a wrong artifact FAILS it — test-the-measure); an empty op[] folds to a valid empty report |
| B2 | blame judge + verify round + the roster composition (pure fn off each `node.json`: id · description · produces/owns) + prose blame writers + the summary fenced-tail emit/parse (the ONLY parsed surface) | tail round-trips; a `node.json` edit changes the composed roster with no other change (no manual sync); judge quality proven by EVAL, not unit: a fixture run with a planted upstream fault must blame the decision node (agent-level), and the manifestation-trap self-check must fire on a bait case |
| B3 | CLI verb `optimize blame <run>` (`<run>` = run dir OR run id/name, plain) `[--latest] [--mode]` + events | verb idempotent; re-run rewrites `blame/`; both arg forms resolve to the same run; events observable on `--watch` |
| B4 | triage ingest seam (§4.1): `buildJudgePrompt` gains `<blame_context>` + the **piflow-triage SKILL.md update** (corroborate-locally · dissent path · global-brief rules — reconciled with the skill's current hand-adjusted text) + the dissent trace plumbing | triage output unchanged when no blame file exists; with one, the minted issue's brief cites the propagated evidence AND defaults `verify: full`; BAIT EVAL: a planted WRONG attribution is CONTESTED with evidence, not minted |
| B5 | adopt train: land-order + staleness policy (pure fn, table-tested) + `stale-base` dropback + branch GC + wait-for-order rule | policy table has a failing test per row; bounce lands the issue at `open` with the dropback recorded; adopted branches are gone, escalated ones remain |
| B6 | blame-memorize into template-root `memory.md` + recurrence read into the next judge (confirm `deriveRecurrence` scope covers template-root lessons; extend if per-node-only) | a second blame pass over a re-observed defect stamps `recurrence:`; memory edits go through the memory-slices contract |
| B7 | (deferred) `optimize run` generation driver; overlord-skill addendum ships FIRST | addendum: the overlord runs one full generation on game-omni live — the M-numbering precedent: the live demo is the eval |

Ordering: B0→B1→B2→B3 are the blame verb (serial); B4 is independent after B2; B5 is independent of all
blame work (pure train hardening — can land first); B6 after B2; B7 last. Per test-discipline: pure folds and
the staleness policy get real unit+mutation gates; the judge and the end-to-end loop get evals (planted-fault
fixture, live generation) — never coverage theater.

## 11. Risks + mitigations

- **Judge attribution accuracy** (~50% agent-level single-pass in SOTA benchmarks): evidence-first pipeline,
  one verify round, joint attribution allowed, `unattributed` escape hatch, and the generation loop as the
  falsifier. Blame is a prior, not a verdict — the doc says so and the overlord treats it so.
- **Goodhart on template criteria**: the runway law holds one level up — a reward-hackable run-level measure
  corrupts every lane under it. Pre-flight VALIDITY is mandatory; `criteria.md` is judge-facing only; blame
  files carry evidence, never rubric.
- **Train starvation / bounce storms**: if bounce+re-prove rates climb (the Mergify hit-rate<80% analog),
  shrink lane parallelism or fall back to MODE T — the summary logs rates so the overlord can see it.
- **Attribution echo chamber** (node triage rubber-stamping whatever blame asserts — upstream context is
  authoritative-sounding by construction): the §4.1 corroborate-locally rule + the dissent path + the WS-B4
  bait eval (a wrong attribution must be contested, and the eval fails if it is minted).
- **Species confusion** (blame read as issue): loud §9 table, distinct dir, and no per-node blame parser at
  all — only the summary tail is machine-read, so nothing can misread a blame file as a lifecycle object.
- **Stale blame consumed by a pinned-run triage**: impossible by construction — triage reads blame from the
  SAME run dir it triages; there is no "latest" copy to go stale.

## 12. External grounding (research pass 2026-07-10)

- **Who&When** (Zhang et al., ICML 2025, arXiv 2505.00212): agent-level attribution 53.5% vs step-level 14.2%
  — node-grain blame is the reliable grain; never promise step-level.
- **CAR** (arXiv 2606.08275): blame the decision node, not the executor; joint causes need credit-splitting —
  our `role:` + `jointWith:` fields.
- **AgenTracer** (arXiv 2509.03312): counterfactual replay beats judge-over-trace — our generation loop is the
  replay; **ADOPT** (arXiv 2512.24933): decouple "what caused it" (structural) from "how to fix" (local
  optimizer) — exactly blame→triage→fixer; weight fix budget by contribution — severity mapping.
- **AgentTrace** (arXiv 2603.14688): 47.4% manifestation-node mis-blame — the backward onset walk is
  mandatory judge input; **RAFFLES** (EACL 2026): judge+verify-round beats single-pass; **judge-gaming**
  (arXiv 2601.14691): verify against artifacts, never self-narration.
- **Merge trains**: Zuul speculative gating (discard-and-retest-behind-the-failure), GitHub merge queue
  (always-revalidate-on-reorder default; disjointness skip is opt-in), bors parallel-batches RFC
  (`CompletedPendingMerge` — landing order enforced independent of completion order), Mergify (speculation
  depth tuned by hit rate). TextGrad/DSPy-style textual backprop is explicitly NOT adopted (documented
  weakness at localizing origin-vs-propagation in looped pipelines).

## Self-check (for whoever implements or extends this)

- [ ] Blame files live ONLY under `<runDir>/optimize/blame/` — no template-side copy, no frontmatter/schema;
      the summary's fenced tail is the ONLY machine-read surface.
- [ ] Every attribution in a shipped blame file cites openable evidence; the manifestation-trap check fired.
- [ ] The node loop changed at exactly ONE seam (triage context ingest) — fix/verify/adopt untouched by blame.
- [ ] Every blame-sourced issue was corroborated by node-local evidence; every uncorroborated attribution left
      a recorded dissent — none were minted to be agreeable, none dropped silently.
- [ ] Recurrence: issue grain on the ledger, blame grain on template-root `memory.md` — no third mechanism.
- [ ] The train never force-lands: every non-`baseSha==HEAD` landing followed the policy table and logged it.
- [ ] Mode was DERIVED from the blame graph (flag only overrides); a MODE P pass logged its reconcile run.
- [ ] The template runway passed pre-flight before the first generation; a failed pre-flight halted the loop
      with "fix the measure," not a blind lane.

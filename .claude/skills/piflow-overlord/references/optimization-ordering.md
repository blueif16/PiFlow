# Overlord reference — optimization ordering (upstream-first, propagate down)

How the overlord SCHEDULES optimization across a MULTI-node workflow. The per-node loop
(`optimize triage → fix → adopt`) belongs to piflow-triage / piflow-fixer; THIS file decides the
ORDER those loops run in, and how one node's improved output becomes the next node's input. Load
it whenever you are optimizing more than one node of a pipeline.

## The principle — a node's quality is bounded by its INPUT
Downstream quality rests on upstream output. Many "downstream defects" are really low-quality
INPUT, not a flaw in the downstream node. So the ORDER you optimize in changes the result: fix an
upstream node first and some downstream defects DISSOLVE (they were input-caused), and every
downstream node then optimizes against the input it will ACTUALLY see in production.

## The staleness law (why you cannot just freeze one good input per node)
A node's frozen/replay input is valid ONLY while its upstream is unchanged. The moment you ADOPT
an upstream fix, every downstream frozen input is STALE — optimizing against it tunes a node to an
input distribution it will never see. Therefore:
- Within ONE node's fix iterations, frozen replay is fine (upstream is held — fast, cheap).
- ACROSS nodes, re-capture the downstream input from the IMPROVED upstream before trusting its
  optimization. NEVER optimize a node against a frozen input whose upstream you already changed but
  did not propagate.

## When the profile elides verify nodes (companion) — the net is GONE, upstream matters MORE
game-omni's default `companion` profile ELIDES the in-graph verify nodes (verify-1 / verify-2 are
DEFINED in the template but not run). So a bad upstream handoff has NOTHING in the graph to catch it
before it reaches the next producer: the OVERLORD is the sole verifier, judging each producer's
landed artifact, and a node's optimize "gate" is its deterministic checks + the replay gate, never a
verify node. With no in-graph net, input quality is even more load-bearing — this STRENGTHENS
upstream-first (and is why the input-cause gate below routes to the upstream AUTHOR, not a verifier).

## Two regimes — pick by time budget and dependency
| | TOPOLOGICAL (default) | PARALLEL (time-boxed / independent nodes) |
|---|---|---|
| when | time allows, OR a real upstream→downstream data edge (the common case) | time is genuinely limited, OR the flagged nodes provably share no data edge |
| how | node 1 → adopt → propagate → node 2 → … → node N, upstream-first | optimize all flagged nodes at once, each against ONE baseline run's input |
| input each node sees | FRESH — reflects every adopted upstream fix | FROZEN — stale-relative-to-final-upstream |
| trade | slower wall-clock; correct, compounding, no re-work | fast; approximate; downstream input-caused defects may persist |
| obligation | none extra | OWES a reconcile pass — run the full pipeline end-to-end once, re-triage, and LOG what the parallel approximation missed (never silently skip) |

Default TOPOLOGICAL. Reach for PARALLEL only under an explicit time crunch or a proven-independent set.

## Propagate = output-of-k becomes input-of-(k+1)  [the mechanism]
After a node's fix ADOPTS, re-materialize the next node's input by re-running the slice from the
improved node — the SAME `--from`/`--until` seam the overlord already uses:
1. optimize node A on baseline run R0 → `piflowctl optimize --node R0.A` (triage→fix) → `piflowctl optimize verify --node R0.A` → `piflowctl optimize adopt --node R0.A`
2. propagate → `piflowctl run <tpl> --from A --until B` → new run R1 (reuses R0's pre-A upstream, re-runs A with the adopted template, so B now consumes A's IMPROVED output)
3. optimize node B on the fresh input → `piflowctl optimize --node R1.B` → adopt
4. repeat down the DAG (B→C→…). Each node is captured ONCE, after all its upstream is final.

(`--node <run>.<id>` pins the exact run; `--from`/`--until` are `run` flags.)

## The input-cause triage GATE (run before any downstream fix)
Before fixing a downstream defect LOCALLY, ask: is this the node's fault, or its INPUT's fault? If
the defect traces to a malformed / low-quality / UNSATISFIABLE input, the fix belongs UPSTREAM —
route it there and re-order; do NOT patch it locally.
EVIDENCE (this pipeline): w4-execute's m2 `entities.count(type==enemy)>=2` and m3 `keyHold Space`
acceptance criteria were UNSATISFIABLE — the fix-surface is UPSTREAM (the AC / blueprint author),
never inside w4. Topological order + this gate is what stops an upstream/ARCH issue from being
mis-bucketed as a local FUNCTIONALITY fix.

## Archetype layering — what TRANSFERS vs what is REDONE per archetype
Optimization touches TWO layers; tag every fix by which one it lands in:
- **Universal process (archetype-AGNOSTIC — transfers):** the node's SKILL / wiring prompt, the
  skeleton FORMAT + field contract, and the deterministic gates' logic. A fix here survives an
  archetype switch and its gains compound across every archetype. (This is the INSTRUCTION-LAYERING
  law: SKILL = process-only · skeleton = field contract.)
- **Per-archetype context (re-DONE per archetype — FIXED FORMAT):** the swappable files a node
  reads for the CURRENT archetype — in `gameplay`, the per-archetype **schema**, **checklist**, and
  **design-rules**. A fix here is scoped to THAT archetype; on an archetype switch the whole set is
  re-authored to the SAME format. Do NOT expect gameplay's platformer-specific design-rules work to
  carry to the next archetype; DO expect the format, the gate logic, and the process to carry. When
  testing a new archetype, re-run the SAME optimization loop over the new archetype's context files.
Order implication: the earliest nodes (w0-classify, w1-design) are the most archetype-agnostic
(classify PICKS the archetype), so their process gains transfer most broadly — a second reason to
optimize upstream-first.

## The overlord procedure (per optimization pass)
desired: every flagged node gates a strict-improvement ADOPT against a REPRESENTATIVE input.
1. List the flagged nodes; topologically sort them along the file-flow edges.
2. Pick the regime (table). Default TOPOLOGICAL; PARALLEL only under the stated conditions (and book
   the reconcile pass, LOGGED).
3. TOPOLOGICAL, each node upstream→down: capture fresh input from the adopted upstream
   (`run --from <prev> --until <this>`) → `optimize --node <run>.<this>` → gate → `adopt` → advance.
   Run the input-cause GATE before any local fix; if input-caused, route upstream and re-order.
4. Tag each landed fix universal-process vs per-archetype-context, so an archetype switch knows what
   carries.
5. Re-observe against the gate verdict + the propagated run — never a self-report.

## Build-status (do not fake a capability)
There is NO one-shot topological-optimize orchestrator verb today: `optimize` is per-node;
`--from`/`--until` + dotted `--node` are the propagation seam; the overlord SEQUENCES the per-node
loops by hand over them. If a single `optimize --all --topological` scheduler is wanted, that is a
follow-on SDK task to FILE, never to fake.

## Self-check (before you report an optimization pass)
- [ ] No node was optimized against an input whose upstream I changed after capture.
- [ ] Every downstream fix passed the input-cause gate (input-caused → routed upstream).
- [ ] Any PARALLEL pass booked + LOGGED a reconcile run.
- [ ] Each landed fix is tagged universal-process vs per-archetype-context.
- [ ] Order followed the DAG (source node first), verified against the gate verdict, not a claim.

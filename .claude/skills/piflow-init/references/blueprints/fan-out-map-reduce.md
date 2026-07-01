# Blueprint: fan-out → map → reduce

The default shape for "split ONE input across N independent workers, then fold their outputs into one result." You
(the init agent) are stamping a workflow whose workers run in PARALLEL over the SAME staged input — each on a
disjoint shard, facet, or an independent point of view — and a final reduce node consolidates them. Unlike
`research-synthesize-author` (fan-out gathers OUTSIDE knowledge, middle designs), here every worker does the SAME
kind of work on ONE staged subject and reduce ADJUDICATES/MERGES/VOTES over their outputs. Read this dir's
`README.md` and the grammar in `AUTHORING-GUIDE.md` first.

## Topology (2 stages)

```
[ worker-1  worker-2  …  worker-N ]   ← stage 1: N PARALLEL workers (same deps, disjoint owns, no worker reads a sibling)
                 │  (all N)
             [ reduce ]               ← stage 2: depends on EVERY worker; folds the N outputs into ONE result
```
N is the only parametric dimension; the reduce spine (one node) is fixed. No plan stage — the subject is staged by
the caller (or a hand-added upstream node) at the boundary input path.

## Parametricity rule — choosing N

**N = one worker per INDEPENDENT shard / facet / point-of-view the subject decomposes into** — never one worker per
line, never a fixed number. Enumerate the independent units FIRST, then map each to a worker.
- **2–3 workers** for a small job (a couple of shards, or a 2–3 voice review panel).
- **5–8 workers** for a broad job (many disjoint shards, or a wide reviewer/facet panel). Cap ~8 — beyond that,
  shard coarser or two-tier the reduce.
- A worker MUST be INDEPENDENT of its siblings: **no worker reads another worker's output** — that independence is
  what makes them one parallel stage and the reduce meaningful (diversity, not an echo). If worker B needs worker
  A's result, it is not a sibling; it belongs after reduce, or the two collapse into one worker.
- Choose the **reduce mode** from what workers emit: `merge` (disjoint shards → stitch into one whole),
  `adjudicate` (overlapping judgements → reconcile into one evidenced verdict), or `vote` (independent verdicts →
  tally a majority). Mode drives the reduce preset in the map below.

## Lane → preset map (`--agent-type <id>`)

| role | base agent (`--agent-type`) | extra tools (`--tool …`) | skill |
|---|---|---|---|
| each worker (skeptical reviewer / facet judge) | **reviewer** | — (preset carries `read write submit_result`) | — |
| each worker (open-web fact/market shard) | **market-research** | — (preset carries its four fs/search tools) | preset's `multi-source-research` |
| each worker (generic bounded task shard) | **general-purpose** | — (preset carries `read write edit bash submit_result`) | — |
| reduce — mode `merge` | **synthesizer** | — | — |
| reduce — mode `adjudicate` / `vote` | **verify** | — | — |

Pick ONE worker row per stamp (all N workers share one preset — same kind of work on different shards). Bind each
node with `--agent-type <id>` — one flag folds the preset's tools + skill + the `agentType` label via `mergePreset`;
the role-prompt is inherited BY REFERENCE at render, so you do NOT prepend it. Each node's `prompt.md` holds ONLY the
shard/mode task (which shard this worker owns; which reduce mode + tie-break rule).

## Per-node I/O seam (read-this → write-that; shape = match the CONSUMER)

- **BOUNDARY input** — the shared subject the caller stages at `{{RUN}}/<ns>/subject.md` (+ optional
  `{{RUN}}/<ns>/criteria.md`). Every worker reads THIS same input; none reads a sibling. (Golden `<ns>` = `verify`.)
- **Each worker** — reads the shared boundary input; writes ONE output to its OWN owned path (disjoint). Shape by
  mode: **PROSE** to `work/<worker>/brief.md` for `merge` (a synthesizer LLM reads it — never force JSON on a
  reasoning hand-off); **strict JSON** to `<ns>/<worker>.json` (`{ verdict, confidence, issues[], … }`) for
  `adjudicate`/`vote` — the verdict IS the machine boundary the reduce tallies.
- **reduce** — `--read`s the whole worker tree (`{{RUN}}/<ns>` or `{{RUN}}/work`), depends on all N, writes ONE
  consolidated result to its own owned path. **BOUNDARY output**: PROSE `out/<name>.md` for `merge`; strict
  `<ns>/verdict.json` (`{ verdict, agreement, blocking_issues[], dissent, summary }`) for `adjudicate`/`vote`. It
  RECONCILES, not concatenates — dedupe, drop the unevidenced/refuted, decide by a NAMED rule (majority /
  corroborated-blocking).

Strict JSON lives ONLY on these machine boundaries (worker verdicts + final verdict); a `merge` fold keeps prose
end-to-end.

## Wiring discipline (so the stages resolve correctly)

- **Workers are ONE parallel stage** ⟺ they share the SAME deps (all `--dep` empty — no upstream — OR all
  `--dep <shared-upstream>` if a hand-added node stages the subject) AND have WRITE-DISJOINT `--owns` (each worker
  `--owns work/<worker>/**` or `--owns <ns>/<worker>.json`, NEVER the default `out/**` for more than one). Two
  workers sharing an `owns` glob = the single most common extract failure — give every worker its own path.
- **No worker `--read`s another worker's output** (that would create a cross-edge and collapse the parallel stage).
- **reduce** `--dep`s on EVERY worker (that is what places it in stage 2) and `--read`s the worker tree
  (`{{RUN}}/<ns>` / `{{RUN}}/work`).
- **`--on-fail block` on EVERY producing node** (all workers, reduce) — each emits a required artifact, so a miss
  must block, not warn.

## Golden pointer

`templates/quality/verify/` — the G3 quality sub-DAG (`adjudicate` mode, N=2), realizing every rule above:
- **workers** `review-a` + `review-b` — `deps: []`, disjoint `owns` `verify/review-a.json` / `verify/review-b.json`,
  reviewer tools `read write submit_result` (no bash), each emits strict JSON `{ verdict, confidence, issues[],
  strengths[], summary }`. Neither reads the other.
- **reduce** `consensus` — `deps: [review-a, review-b]`, `readScope {{RUN}}`, owns `verify/verdict.json`, emits
  `{ verdict, agreement, blocking_issues[], dissent, summary }` by a named majority/corroborated-blocking rule.
- Boundary input `{{RUN}}/verify/subject.md` (+ optional `criteria.md`); boundary output `{{RUN}}/verify/verdict.json`.
- All three nodes carry `policy.fail: block`. Scale N by adding more `verify/review-*.json` workers — `consensus`
  reads every `review-*.json` in the tree already.

## The bar (revise the stamped template until ALL pass)

1. `piflowctl extract <dir>` EXITS 0 and shows N workers in ONE parallel stage, then reduce (2 stages).
2. Every node dir has BOTH `node.json` AND a non-empty `prompt.md` (task-only when `--agent-type` is used).
3. Every worker has a WRITE-DISJOINT `--owns` glob; NO worker reads a sibling; reduce `--dep`s every worker and
   `--read`s the worker tree.
4. Every producing node has `policy.fail: block`.
5. N and the reduce mode were chosen by the parametricity rule (one worker per independent shard/facet;
   merge/adjudicate/vote from what workers emit), not arbitrarily.
6. Worker output shape matches the reduce mode (prose for `merge`; strict JSON for `adjudicate`/`vote`).

## Self-check before returning

Stamp, then audit against the six bar items — mark PASS/FAIL with one line of evidence each (for item 1, paste the
literal extract output). The most likely FAIL is item 1 from non-disjoint `owns` — give every worker its own path
and re-extract. The second is item 3 — a worker `--read`ing a sibling collapses the parallel stage. Fix every FAIL,
re-audit, return only when all six PASS. If extract stays red for a cause you cannot resolve, HALT and report the
exact error, do not claim green.

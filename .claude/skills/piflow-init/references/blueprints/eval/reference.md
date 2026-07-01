# Compose-eval reference oracle (CRITIC ONLY — never shown to the COMPOSE agent)

For each task: the correct blueprint, the lane-count range, the `must` wiring signature, and the `must-not`
(wrong shapes). Score a stamped DAG PASS iff it satisfies every `must` and violates no `must-not`. Judge SHAPE
(blueprint choice · lane count · wiring), not prose or ids.

---

## T1 — outreach workflow design → **research-synthesize-author**
- must: N parallel research lanes (N = 2–4, one per independent area ≈ deliverability · enrichment · analytics)
  with disjoint `owns`, all `deps:[]`; → one `synthesize` (deps ALL lanes); → one `author` (deps synthesize).
- must: research lanes bound to `market-research`; author emits a template/artifact under `out/**`.
- must-not: a single linear chain with no fan-out; lanes that read each other (not independent); no synthesize
  join (lanes feeding author directly).

## T2 — self-correcting config build → **produce-verify-fix** (N=1)
- must: `produce → verify` with `verify` carrying a reroute back to `produce` (`op rerouteTo{produce, K}`),
  `--on-fail block`; a `plan` head is acceptable/encouraged. verify is READ-ONLY (creates no key artifact).
- must: exactly ONE produce→verify segment (one deliverable).
- must-not: parallel workers (there is one deliverable, not N shards); a verify node that WRITES the config
  (conflates producer + verifier); no reroute/loop (a one-shot produce→verify with no self-fix).

## T3 — independent review panel → consensus → **fan-out-map-reduce** (adjudicate)
- must: N parallel workers (N = 2–5) with disjoint `owns`, NO worker reading a sibling; → one `reduce`/consensus
  node (deps ALL workers) that reconciles into one verdict.
- must: workers bound to `reviewer` (or similar read-only judge); reduce bound to `verify`/`synthesizer`.
- must-not: a serial chain of reviewers (each reading the previous — kills independence); a single reviewer; no
  reduce/consensus node.

## T4 — spec then build parts in parallel → **spec-fanout-build** (M=3)
- must: `design` freezes ONE spec (strict `spec/blueprint.json`); → M parallel producers (M = 3: types · impl ·
  tests) each `--dep design`, disjoint `frag/<facet>/**` owns, each reading ONLY the spec; → `verify-join` (deps
  all producers); → `build` (deps verify-join, assembles `out/**`).
- must-not: producers writing competing full candidates (that is candidate-fusion, not disjoint fragments);
  producers reading each other; no frozen-spec node (producers inventing their own interface); no verify-join.

## T5 — panel-drafted, hardened explainer → **candidate-fusion-refine**
- must: linear `plan → draft → harden → publish`; `draft.node.json` has `fusion.mode:"moa"` with a `panel`
  array (+ judge); `harden.node.json` has `fusion.mode:"best-of-n"` with integer `n`.
- must: disjoint owns per node; the siblings/judge are NOT hand-authored (fusion flags materialize them).
- must-not: hand-authored `__judge`/sibling nodes; a plain single-model draft/harden with no `fusion` block; a
  parallel-candidates fan-out with a separate authored judge (that reinvents fusion by hand).

## T6 — implement-and-fix a function → **produce-verify-fix** (N=1) — THE FALSIFIER
- must: `produce → verify(reroute→produce, K)` sequential self-fix loop; ONE segment; verify read-only.
  A `debugger`-bound fix inside the loop is fine (produce/fix is the same slot).
- **must-not (the falsifier):** `fan-out-map-reduce`. This task is inherently SERIAL — one function, one test, a
  sequential gate-and-fix loop. There are NO independent shards to fan out and NO consensus to reduce. A
  map-reduce composition MUST score **FAIL**.
- **Test-the-test:** feed the critic a PLANTED `fan-out-map-reduce` stamping of T6 (parallel "fixer" workers →
  a consensus reduce). The critic MUST return FAIL, citing the missing serial gate loop / absent independent
  shards. If it returns PASS, the critic is only checking `extract`-green, not SHAPE — the eval is void until
  the critic is fixed.

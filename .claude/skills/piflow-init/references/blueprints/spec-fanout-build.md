# Blueprint: spec fan-out → build

The shape for "one design decides the whole thing, then many hands fill DISJOINT parts of it in parallel, then
we join and build." You (the init agent) are stamping a workflow whose first node FREEZES a single spec, a
middle stage of producers each fills one orthogonal FACET of that spec (they are COLLABORATORS on one artifact,
NOT competing candidates), a verify-join gates that they cohere, and a build node assembles the whole. Read the
layer contract in this dir's `README.md` first. This file gives you the topology, how to size M, and how to wire
it so `piflowctl extract` comes out green with the right stages.

## Topology (4 stages)

```
              [ design ]                        ← stage 1: FREEZES one spec (spec/blueprint.json)
                  │  (all M read the frozen spec)
[ producer-1  producer-2  …  producer-M ]       ← stage 2: M PARALLEL lanes, each owns ONE facet's fragment
                  │  (all M)
             [ verify-join ]                     ← stage 3: depends on EVERY producer; RETURNS a PASS/FAIL gate
                  │
               [ build ]                          ← stage 4: assembles the fragments into the final module
```
M is the only parametric dimension; the spine (design, verify-join, build) is fixed.

## Parametricity rule — choosing M

**M = one producer per ORTHOGONAL FACET of the frozen spec** — a slice of the ONE artifact that can be written
without reading a sibling's output. Enumerate the spec's disjoint facets FIRST, then map each to a lane.
- **2–6 facets** is the healthy band (e.g. types · impl · tests; or api · storage · ui · docs).
- Merge two facets that must be co-edited to stay consistent; split one facet that carries two independent files.
- A producer must be INDEPENDENT of its siblings — every producer reads ONLY the frozen spec, never a sibling's
  fragment. If producer B needs producer A's fragment, they are not siblings: fold them into one lane, or move
  the dependent work AFTER verify-join. This independence is what makes them one parallel stage.
- NOT candidates: every producer fragment SHIPS (build consumes all of them). If you want competing drafts and
  a pick, that is `candidate-fusion-refine`, not this.

## Lane → base-agent binding (`--agent-type <id>`)

| role | base agent (`--agent-type`) | extra tools (`--tool …`) | skill |
|---|---|---|---|
| design | **plan** | `--tool write` (add persist) | — |
| each producer | **coder** | — (preset carries `read write edit bash submit_result`) | preset's `test-discipline` |
| verify-join | **verify** | — (preset carries `read submit_result`) | preset's `receiving-code-review` |
| build | **coder** | — (preset carries `read write edit bash submit_result`) | preset's `test-discipline` |

Bind each node with `--agent-type <id>` — one flag folds the preset's tools + skill + the `agentType` label via
`mergePreset`; the role-prompt is inherited BY REFERENCE at render, so you do NOT prepend it. `plan` is read-only
by default — ADD `--tool write` so design can persist the frozen spec. Each node's `prompt.md` holds ONLY the
node's task (the role comes from the preset at render).

## Per-node I/O contract (read-this → write-that; shape = match the CONSUMER)

- **design** — reads `{{RUN}}` (the request); writes ONE spec to `spec/blueprint.json`. This is a **BOUNDARY
  seam AND a machine boundary**: it is **strict JSON** because MANY readers (every producer + verify-join) parse
  it and it is FROZEN — immutable once written, never re-negotiated. It must enumerate, per facet, the exact
  fragment path a producer owns, the interface that fragment satisfies, and how the facets compose.
- **each producer** — reads `{{RUN}}/spec` (the frozen `blueprint.json`); writes ONE fragment to its own owned
  `frag/<facet>/**` (e.g. `frag/types/types.md`). Output is **PROSE** (verify-join and build — both LLMs — read
  it; never force JSON on a reasoning hand-off). Each producer fills ONLY its assigned facet against the frozen
  interface, so the fragments are write-disjoint AND compose.
- **verify-join** — reads ALL `frag/` + `{{RUN}}/spec`; produces NO artifact — it RETURNS a PASS/FAIL verdict
  (`--return-mode required`, a **machine boundary**: the join gate). It checks each facet exists, honors the
  frozen interface, and composes with the others (no gap, no overlap, no drift). Any FAIL blocks build.
- **build** — reads the verified `frag/`; writes the assembled module to its owned `out/**`. This is the second
  **BOUNDARY seam** (the fragment's last output). Strict structure lives only on the two machine boundaries (the
  frozen `blueprint.json`, the verify RETURN) — never on the intermediate fragments.

## Wiring discipline (so the stages resolve correctly)

- **Producers are ONE parallel stage** ⟺ they share the SAME dep (`--dep design`) AND have WRITE-DISJOINT `owns`
  (each `--owns frag/<facet>/**`, never the default `out/**` for more than one). Non-disjoint owns on same-level
  nodes = the loader will NOT parallelize them (or rejects the lane) — the single most common extract failure.
  Give every producer its own `frag/<facet>/**` glob.
- **design** owns `spec/**`, reads `{{RUN}}` (a true root — no upstream dep).
- **verify-join** `--dep`s on EVERY producer (that is what places it in stage 3), `--read`s `{{RUN}}/frag` +
  `{{RUN}}/spec`, and takes `--return-mode required` (the verdict IS its output; it owns `verify/**`).
- **build** `--dep`s on verify-join only, reads `{{RUN}}/frag`, owns `out/**`.
- **`--on-fail block` on EVERY producing node** (design, all producers, verify-join, build) — each emits a
  required artifact or a required verdict, so a miss must block, not warn.

## The bar (revise the stamped template until ALL pass)

1. `piflowctl extract <dir>` EXITS 0 and shows: design (stage 1) → M producers in ONE parallel stage (stage 2)
   → verify-join (stage 3) → build (stage 4) — 4 stages.
2. Every node dir has BOTH `node.json` AND a non-empty `prompt.md` (task-only when `--agent-type` is used).
3. design's artifact is `spec/blueprint.json` and its tools include `write`; each producer carries
   `agentType: coder` with a disjoint `frag/<facet>/**` owns; verify-join carries `returnMode: required`.
4. Every producing node has `policy.fail: block`.
5. M was chosen by the parametricity rule (one producer per orthogonal facet), not arbitrarily — and every
   producer reads ONLY `{{RUN}}/spec`, never a sibling.

## Self-check before returning

Stamp, then audit against the five bar items — mark PASS/FAIL with one line of evidence each (for item 1, paste
the literal extract output). The most likely FAIL is item 1 from non-disjoint `owns` — fix the `frag/<facet>/**`
globs and re-extract. Fix every FAIL, re-audit, return only when all five PASS. If extract stays red for a cause
you cannot resolve, HALT and report the exact error, do not claim green.

## Golden worked instance

`.piflow/example-spec-fanout/template/` — the spec fan-out → build designer: design freezes `spec/blueprint.json`
→ 3 producers (types · impl · tests) each own `frag/<facet>/**` → verify-join (required return) → build assembles
`out/module.md`. Inspect it for a concrete realization of every rule above.

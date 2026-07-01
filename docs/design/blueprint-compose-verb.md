# Design — `piflowctl blueprint` (the deterministic blueprint→template stamp/insert seam)

**Status:** DESIGN (build deferred). The 4 blueprints + 2 new goldens were hand-stamped via `new`+`add-node`
this round; this doc specs the verb that makes that stamping a deterministic, tested code path, validated to
reproduce those goldens.

## Motivation — split the mechanical wiring from the intelligent holes

Composing a DAG from a blueprint (see `.claude/skills/piflow-init/references/blueprints/AUTHORING-GUIDE.md`)
today means an agent loops `piflowctl add-node` per slot, choosing each flag by hand. Two kinds of work are
tangled in that loop:

- **INTELLIGENT (stays with the agent):** how many lanes (N/M/K), what each lane does, which preset each binds
  to, the `prompt.md` prose, and — on an insert — which surrounding paths the boundary seams bind to.
- **MECHANICAL (should be a tested code path):** given those choices, emitting the exact wiring —
  namespaced node ids, disjoint `owns` globs, `--dep` edges, `--on-fail block`, `--agent-type`, the reroute op.
  This is a *fixed function of the choices*, with no judgment — exactly the "push the mechanical into a driver
  hook / code path" law (`piflow-init/SKILL.md` → *Designing a node's I/O*).

The verb owns the mechanical half. It reads a blueprint's wiring rule + a small agent-produced **lane-plan**
(the intelligent holes) and stamps the skeleton over the existing `buildNode`/`scaffoldAddNode`. `extract` stays
the oracle. **It adds NO DAG logic** — edges still derive from `io.reads ⋈ io.produces` (`inferEdges`); the verb
only batches `add-node` calls it could have typed by hand.

## Surface

```
piflowctl blueprint stamp  <blueprint-id> --plan <lane-plan.json> --into <new-dir>
piflowctl blueprint insert <blueprint-id> --plan <lane-plan.json> --into <existing-dir> [--ns <prefix>]
piflowctl blueprint list          # the ~/.piflow/blueprints/ catalog
```

- **stamp** — `piflowctl new <new-dir>` then one `scaffoldAddNode` per lane; the whole blueprint into a fresh
  template dir.
- **insert** — `scaffoldAddNode` the blueprint's lanes INTO an existing template dir, applying the 3 insert
  disciplines (guide §4): namespace the ids by `--ns`, namespace the writes under `{{RUN}}/<ns>/…`, and bind the
  input seam to a surrounding path named in the lane-plan. (Reuses the `graph-rewrite.ts` id-namespacing pattern
  that `expandSubworkflow` already uses.)
- Both END by running the `extract` oracle and failing non-zero if the derived DAG is not green.

## The lane-plan (the intelligent holes, agent-authored)

A blueprint's `.md` fixes the topology + wiring rule; the lane-plan fills its holes. Shape (illustrative — the
real schema lives beside the verb, validated on load):

```json
{
  "blueprint": "produce-verify-fix",
  "params": { "N": 1, "K": 3, "planHead": true },
  "lanes": [
    { "role": "plan",    "id": "plan",    "agentType": "plan",   "extraTools": ["write"] },
    { "role": "produce", "id": "produce", "agentType": "coder"  },
    { "role": "verify",  "id": "verify",  "agentType": "verify" }
  ],
  "seams": { "input": "{{RUN}}/spec/request.md" }
}
```

The verb maps each lane through the blueprint's wiring rule → the exact `buildNode` flags (deps, disjoint owns,
artifact, reads, on-fail, reroute, return-mode). The agent still `Write`s each `prompt.md` (task-only) — the
verb never authors prose (the standing scaffolder rule).

## Determinism contract (the acceptance test for the build)

The verb is correct iff, given the lane-plan implied by each hand-stamped golden, it reproduces that golden's
`node.json` set **byte-for-byte**. The 4 goldens are the fixtures:

- `.piflow/example-produce-verify-fix/template/` (produce-verify-fix, N=1/K=3)
- `.piflow/example-spec-fanout/template/` (spec-fanout-build, M=3)
- `templates/quality/verify/` (fan-out-map-reduce, N=2 adjudicate)
- `.piflow/example-fusion/template/` (candidate-fusion-refine)

A round-trip test (`stamp(plan) → node.json === golden node.json`) is the gate; `extract` green is necessary
but not sufficient (it would pass a mis-wired-but-valid DAG).

## Boundaries / invariants

- **Pure composition over `buildNode`** (`packages/cli/src/scaffold.ts`) — no new emit logic, no `@piflow/core`
  change. Edges are never drawn; `extract`/`inferEdges` derive them.
- **The verb writes no prose** — `prompt.md` stays the agent's, Written after the stamp.
- **`insert` never mutates a node it did not add** — it only appends namespaced lanes + (optionally) binds a
  downstream consumer's read to a new produce; the existing nodes are untouched (the additive-rewrite rule from
  `graph-rewrite.ts`).
- **The same verb serves all three loops** — build-first (init), design-next (the redesign node stamps the next
  template), improve-prev (the optimizer inserts a verify/reroute lane). One deterministic stamp, three callers.

## Why deferred (build order)

Building the verb against the 4 *proven* goldens de-risks it (reproduce-known-good, not speculate). The interim
mechanism — the agent following `AUTHORING-GUIDE.md` + the scaffold loop — already composes correctly (proven by
the goldens + the compose eval). Ship the verb when the round-trip fixtures are in place.

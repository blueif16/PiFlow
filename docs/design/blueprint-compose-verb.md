# Design — `piflowctl blueprint` (the deterministic blueprint→template stamp/insert seam)

**Status:** DESIGN — RESOLVED / build-ready (2026-07-01 audit closed the 4 open holes; see *Resolved decisions*).
The 4 blueprints + 2 new goldens were hand-stamped via `new`+`add-node` this round; this doc specs the verb that
makes that stamping a deterministic, tested code path, validated to reproduce those goldens.

## Resolved decisions (2026-07-01 — these are locked; implement to them)

1. **Gate = parsed deep-equal, not byte-for-byte.** The verb emits canonical `toJson`
   (`JSON.stringify(o,null,2)`); two of the four goldens (`example-fusion`, `templates/quality/verify`) were
   hand-authored with COMPACT single-line arrays, so a byte comparison false-fails on whitespace alone. The gate
   compares `JSON.parse(stamped)` deep-equal to `JSON.parse(golden)`. Consequence: **no golden is re-normalized
   and no golden `node.json` is edited** — the hand-authored goldens are fixtures AS-IS, and each lane-plan
   encodes its golden's ACTUAL state (e.g. `agentType: null` where a golden predates presets).
2. **Reviewer lane fix is doc-only, upstream of the verb.** `fan-out-map-reduce.md` binds the reviewer worker
   `--agent-type reviewer --tool write` (the preset is read-only `[read, submit_result]`; `write` is added to
   persist the verdict JSON — same pattern as the `plan` lane in `research-synthesize-author`). The
   `templates/quality/verify` golden keeps `agentType: null` + hand-wired tools; its lane-plan encodes that.
3. **`blueprint list` reads the shipped skill catalog**, not `~/.piflow/`. Blueprint-id → file resolution is
   `<piflow-init skill>/references/blueprints/<id>.md`, with an OPTIONAL `~/.piflow/blueprints/<id>.md` user
   overlay taking precedence when present. `list` enumerates the union.
4. **`insert` MAY extend a downstream consumer's seam** (corrects the old contradiction, see *Boundaries*).

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
piflowctl blueprint list          # the shipped skill catalog (references/blueprints/) ∪ ~/.piflow/blueprints/ overlay
```

- **stamp** — `piflowctl new <new-dir>` then one `scaffoldAddNode` per lane; the whole blueprint into a fresh
  template dir.
- **insert** — `scaffoldAddNode` the blueprint's lanes INTO an existing template dir, applying the 3 insert
  disciplines (guide §4): namespace the ids by `--ns`, namespace the writes under `{{RUN}}/<ns>/…`, and bind the
  input seam to a surrounding path named in the lane-plan. (Reuses the `graph-rewrite.ts` id-namespacing pattern
  that `expandSubworkflow` already uses.)
- Both END by running the `extract` oracle and failing non-zero if the derived DAG is not green.

## The lane-plan (the intelligent holes, agent-authored)

A blueprint's `.md` fixes the topology + wiring rule; the lane-plan fills its holes. The schema (validated on
load; lives beside the verb) must express EVERY field the four goldens carry — the earlier "illustrative" sketch
omitted `fusion`/`inject`/`checks`/`deny`/`tier`/no-preset, which the `example-fusion` golden requires. Full
per-lane field set (all optional except `role`+`id`):

```json
{
  "blueprint": "produce-verify-fix",
  "params": { "N": 1, "K": 3, "planHead": true },
  "lanes": [
    {
      "role": "plan",          // the blueprint slot this lane fills (drives the wiring rule)
      "id": "plan",            // authored node id (the verb namespaces it on insert)
      "agentType": "plan",     // preset id, or null / omitted for a no-preset (hand-wired) lane
      "extraTools": ["write"], // tools ADDED on top of the preset/defaults (e.g. plan/reviewer + write)
      "denyTools": ["bash"],   // tools removed (fusion's draft/harden deny bash)
      "tier": "deep",          // model tier when the lane pins one (fusion judge/harden)
      "skill": null,           // skill ref when NOT inherited from the preset
      "fusion": null,          // { mode:"moa"|"best-of-n", panel?:[...], n?, judge? } for a fusion lane
      "inject": [],            // inject entries the golden carries
      "checks": null           // { post: [...] } post-gates (quality/verify workers carry json-parses + field-present)
    },
    { "role": "produce", "id": "produce", "agentType": "coder" },
    { "role": "verify",  "id": "verify",  "agentType": "verify" }
  ],
  "seams": { "input": "{{RUN}}/spec/request.md" }
}
```

A lane with `agentType: null` (or omitted) is a NO-PRESET lane: the verb hand-wires `tools.allow` from
defaults ∪ `extraTools` (this is how the `templates/quality/verify` workers — `agentType: null`,
`[read, write, submit_result]` — round-trip). The verb maps each lane through the blueprint's wiring rule → the
exact `buildNode` flags (deps, disjoint owns, artifact, reads, on-fail, reroute, return-mode, fusion, inject,
checks, deny, tier). The agent still `Write`s each `prompt.md` (task-only) — the verb never authors prose (the
standing scaffolder rule).

**Machine-readable wiring rule.** Today each blueprint `.md` states its wiring rule as PROSE (the tables +
"wiring discipline" section). For a DETERMINISTIC verb, each blueprint needs a parseable rule (owns-glob pattern
per role, dep pattern, on-fail default, reroute target for the fix-loop role, which roles are the parallel
stage). Encode it as a small `wiring` block the verb reads — either a front-matter/JSON sidecar per blueprint
`.md`, or a `wiring-rules.json` keyed by blueprint-id. The prose stays the human/agent-facing guide; the
sidecar is the verb's source of truth. Building it FROM the 4 goldens (read each golden's node.json set, derive
the per-role pattern) keeps rule and fixture in agreement by construction.

## Determinism contract (the acceptance test for the build)

The verb is correct iff, given the lane-plan implied by each hand-stamped golden, it reproduces that golden's
`node.json` set — compared **parsed deep-equal** (`JSON.parse(stamped)` ≡ `JSON.parse(golden)`), NOT byte string
(decision 1: the goldens' compact vs. canonical whitespace differs but is semantically identical). The 4 goldens
are the fixtures, used AS-IS (no re-normalization):

- `.piflow/example-produce-verify-fix/template/` (produce-verify-fix, N=1/K=3)
- `.piflow/example-spec-fanout/template/` (spec-fanout-build, M=3)
- `templates/quality/verify/` (fan-out-map-reduce, N=2 adjudicate — `agentType: null` lanes)
- `.piflow/example-fusion/template/` (candidate-fusion-refine — `fusion`/`inject`/`checks`/`deny` lanes)

A round-trip test (`deepEqual(JSON.parse(stamp(plan)), JSON.parse(golden))` per node) is the gate; `extract`
green is necessary but not sufficient (it would pass a mis-wired-but-valid DAG). Scope of the compare: the
per-node `node.json` set + `meta.json`. `prompt.md` is the agent's (not emitted, not compared). If `workflow.json`
is loader-derived rather than authored, exclude it; if authored, include it — the implementer resolves this
against `loadTemplate` and records which.

## Boundaries / invariants

- **Pure composition over `buildNode`** (`packages/cli/src/scaffold.ts`) — no new emit logic, no `@piflow/core`
  change. Edges are never drawn; `extract`/`inferEdges` derive them.
- **The verb writes no prose** — `prompt.md` stays the agent's, Written after the stamp.
- **`insert` never mutates an existing node's PROMPT or OWNS; it MAY extend a consumer's seam** (corrects the
  old self-contradiction). Binding the inserted fragment into the DAG means the verb may append to a pre-existing
  downstream consumer's `deps` and `readScope`/`reads` so it reads the new produce — that is the ONLY mutation
  permitted on a node it did not add, and it is additive (never rewrites/removes an existing dep, owns glob, or
  prompt). Everything the verb ADDS is namespaced by `--ns`: node ids, disjoint `owns` globs, `{{RUN}}/<ns>/…`
  write paths, `--dep` values, AND the reroute target (`op.action.node` must still resolve to a strict ancestor
  after namespacing). The `graph-rewrite.ts` id-namespacing that `expandSubworkflow` uses operates on load-time
  `NodeIntent`, not authored `node.json`, so the verb needs its OWN small string-namespacing helper at the
  scaffolder layer (do not reuse the load-time transform directly).
- **The same verb serves all three loops** — build-first (init), design-next (the redesign node stamps the next
  template), improve-prev (the optimizer inserts a verify/reroute lane). One deterministic stamp, three callers.

## Build order

Building the verb against the 4 goldens de-risks it (reproduce-known-good, not speculate). The interim mechanism
— the agent following `AUTHORING-GUIDE.md` + the scaffold loop — composes the goldens; the compose eval is being
made reproducible in the same effort (a committed runner + captured run), so "the agent picks the right shape"
becomes evidenced rather than asserted. Build sequence, test-first:

1. **`stamp` for the 2 linear/fan-out goldens** (produce-verify-fix, spec-fanout) — these are already canonical;
   round-trip them first (deep-equal). Derive each blueprint's machine-readable wiring rule FROM the golden.
2. **`stamp` for fusion + quality/verify** — exercises the full lane-plan field set (`fusion`/`inject`/`checks`/
   `deny`/no-preset). Round-trip deep-equal.
3. **`insert`** — the namespacing helper + seam-rebind; test against a synthetic insert (e.g. splice a review
   panel into produce-verify-fix) with `extract` green + the additive-only invariant asserted.
4. **`list`** — enumerate the skill catalog ∪ overlay.

Each step: failing round-trip/extract test FIRST, then the code to pass it. The 4 goldens are unchanged fixtures.

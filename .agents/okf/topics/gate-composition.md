---
type: subsystem
key: gate-composition
title: Gate composition (the additive typed gate list → op[]/judge/checkpoint lowering)
description: How a node's authored `gates: GateEntry[]` (execution|agentic|hitl) is fanned out at LOAD time onto the three carriers that already exist — execution → op.gate/op.run folded into io.checks, agentic → the judgeGate slot (materialized), hitl → the checkpoint slot — via a pure author-time lowering with single-slot + cost-ladder invariants. The AUTHOR side of gating; the RUNTIME evaluation of the emitted op[] is owned by node-action-protocol.
resource: packages/core/src/workflow/gate-list.ts
aliases: [gates, gate list, GateEntry, additive gate, execution gate, agentic gate, hitl gate, judge gate, fanoutGates, lowerGate, gate lowering, gate authoring, cost ladder, costLadderOrder, GateAuthorSpec, gate composition, single judge slot]
seeds: [packages/core/src/workflow/gate-list.ts, packages/core/src/workflow/gate-authoring.ts, packages/core/src/workflow/template/schema/gate-entry.schema.ts]
symbols: [fanoutGates, GateEntry, GateListError, executionToAuthorSpec, lowerGate, lowerGates, GateAuthorSpec, costLadderOrder, GatePolicy, gateEntrySchema]
tags: [gates, gate-list, authoring, judge, checkpoint, lowering, cost-ladder, core]
timestamp: 2026-07-07
---

# Why / how it works (the lifecycle, end to end)
A node authors its gating as a typed ADDITIVE LIST — `gates: GateEntry[]` on `node.json` (schema field
`node.schema.ts` §gates; each entry validated by the SHARED `gateEntrySchema` fragment, a `oneOf` over the three
owner types `execution`/`agentic`/`hitl`). There is NO on/off switch — composition is append-only: the TEMPLATE
default carries `execution` gates and a profile overlay APPENDS more (see [[run-profiles]]). At LOAD time, inside
`toNodeIntent`, `fanoutGates(node.gates, id)` lowers the list onto the three carriers that ALREADY exist — reusing,
never duplicating: `execution` → `lowerGate` (`gate-authoring.ts`) emits either an `op.gate` (a `check` predicate,
whose post `Check` is re-derived via `gatesFromOp(ops).post` into `io.checks`) or an `op.run` (a `cmd` script the
runner dispatches); `agentic` → the node's SINGLE `judgeGate` slot, later expanded by `materializeJudgeNodes` into a
real `<id>__judge` pi node on a different model; `hitl` → the node's SINGLE `checkpoint` slot (the G5 human gate). A
node has ONE judge and ONE checkpoint slot, so a second `agentic`/`hitl` (or a collision with a directly-authored
`judgeGate`/`checkpoint`) is a loud `GateListError`; `execution` gates stack freely and always fire first via the
cost ladder (`costLadderOrder`: deterministic → judge → human — never spend a person on what a predicate already
caught). The whole fan-out is author-time + PURE (no I/O); the emitted `op[]`/`Check[]` are then EVALUATED at
runtime by the [[node-action-protocol]] engine — that is the terminal seam, owned there, not here.

# Anchors
DECLARE (the authored surface)
- `packages/core/src/workflow/template/schema/node.schema.ts:330` — `gates` — the authored `gates[]` field on node.json (fanned out at load)
- `packages/core/src/workflow/template/schema/gate-entry.schema.ts:25` — `gateEntrySchema` — the SHARED `oneOf(execution|agentic|hitl)` fragment (embedded by both node.schema + profile.schema under `$defs.gateEntry`)
- `packages/core/src/workflow/gate-list.ts:33` — `GateEntry` — the discriminated-union TS twin of the schema (execution|agentic|hitl)
FANOUT (per node, at load — inside toNodeIntent)
- `packages/core/src/workflow/template/loader.ts:139` — `fanoutGates(n.def.gates, n.def.id)` — the per-node fan-out call, BEFORE `materializeJudgeNodes`
- `packages/core/src/workflow/gate-list.ts:122` — `fanoutGates` — lowers `gates[]` onto the three carriers; ≤1 agentic/hitl or loud `GateListError`
- `packages/core/src/workflow/gate-list.ts:91` — `executionToAuthorSpec` — maps an `execution` entry → a `floor`/`execution` `GateAuthorSpec`
LOWER (one entry → op[]/judge/checkpoint)
- `packages/core/src/workflow/gate-authoring.ts:235` — `lowerGate` — one `GateAuthorSpec` → `OpSpec[]` (+ `judgeNode`/`checkpointPatch`); pure, author-time only
- `packages/core/src/workflow/gate-authoring.ts:144` — `GateAuthorSpec` — the `ExecutionGate|FloorGate|JudgeGate|HumanGate` union `lowerGate` speaks
- `packages/core/src/workflow/gate-authoring.ts:165` — `costLadderOrder` — stable sort: deterministic(0) → judge(1) → human(2)
- `packages/core/src/workflow/gate-authoring.ts:32` — `GatePolicy` — per-gate `onFail`/`retryMax`/`retryScope` carried through the lowering
SEAM (terminal — the emitted op[] is consumed elsewhere)
- `packages/core/src/workflow/gate-list.ts:166` — `gatesFromOp(ops).post` — execution gates' POST `Check[]` re-derived into `io.checks` (→ [[node-action-protocol]])
- `packages/core/src/workflow/template/loader.ts:347` — `materializeJudgeNodes` — the fanned `judgeGate` → a real `<id>__judge` node (owner: judge/materialize.ts, itself uncovered)

# Freshness (anti-drift)
anchors ✓ (all opened 2026-07-07) · scope = the three seeds above · re-derive when they change · DRIFT NOTE:
(1) The fan-out is WIRED at `loader.ts:139` and runs INSIDE `toNodeIntent` BEFORE `materializeJudgeNodes`
(`loader.ts:347`) — the two MUST stay in that order (a profile-added agentic gate must materialize on the authored
path). (2) `gate-entry.schema.ts` is SHARED verbatim by `node.schema.ts` AND `profile.schema.ts` (each embeds it under
`$defs.gateEntry`) — a change to the fragment blasts BOTH schemas; keep it self-contained (policy inlined, no
cross-schema `$ref`). (3) This card owns the AUTHOR→op[] lowering only; the RUNTIME evaluation of the emitted
op[]/checks (verdict → block/warn/stop/retry) belongs to [[node-action-protocol]] (`gatesFromOp`/`evaluateChecks`),
the agentic→judge node expansion to `judge/materialize.ts`, and the hitl→checkpoint to the G5 runtime — three seams
OUTSIDE this slice. (4) Covered by `packages/core/test/gate-list-profiles.test.ts` (append merge, judge materialize)
+ `packages/core/test/gate-authoring.test.ts` (lowerGate). Design: `docs/design/gate-list-and-additive-profiles.md`
§a. Related: [[run-profiles]] (the overlay that appends these GateEntry[]), [[node-action-protocol]] (the runtime).

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/workflow/gate-list.ts` | ✓ |
| `packages/core/src/workflow/gate-authoring.ts` | ✓ |
| `packages/core/src/workflow/template/schema/gate-entry.schema.ts` | ✓ |

### Evolution arc

- `52f05ec` 2026-06-28 — feat(core): gate authoring → op[] lowering + retry.scope (SA-B)
- `2e125ad` 2026-07-06 — feat(core): schema + types for the additive gate list and profile overlay
- `e9c58ee` 2026-07-06 — feat(core): gate-list fan-out + profile-overlay loader modules

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[claude-code-executor]]
- [[cloud-control-plane-local-cloud-switch]]
- [[cloud-sandbox-portability]]
- [[compose-gate-drag-audit]]
- [[design-at-init-architecture]]
- [[expert-representations]]
- [[issue-lifecycle-gate-redesign]]
- [[omniscience-piflow-setup]]
- [[op-consumption-two-layer]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-init-scaffolder]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[sandbox-readscope-default-on]]
- [[skill-marketplace-gui-design]]
- [[telemetry-legibility-tracks]]

### Code anchors / blast radius (codegraph)

- `lowerGates` (packages/core/src/workflow/gate-authoring.ts:323) — 6 callers in `packages/core/src/workflow/agent-base.ts`, `packages/core/src/workflow/judge/materialize.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/gate-authoring.test.ts`
- `fanoutGates` (packages/core/src/workflow/gate-list.ts:122) — 3 callers in `packages/core/src/workflow/template/loader.ts`, `packages/core/src/index.ts`; ⚠ no covering tests found
- `lowerGate` (packages/core/src/workflow/gate-authoring.ts:235) — 5 callers in `packages/core/src/workflow/gate-authoring.ts`, `packages/core/src/workflow/gate-list.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/gate-authoring.test.ts`
- `GateAuthorSpec` (packages/core/src/workflow/gate-authoring.ts:144) — 12 callers in `packages/core/src/workflow/agent-base.ts`, `packages/core/src/workflow/gate-list.ts`, `packages/core/src/workflow/judge/materialize.ts`, `packages/core/src/index.ts` +1 more; tests: `packages/core/test/gate-authoring.test.ts`
- `GatePolicy` (packages/core/src/workflow/gate-authoring.ts:32) — 10 callers in `packages/core/src/workflow/gate-list.ts`, `packages/core/src/index.ts`, `packages/core/src/workflow/gate-authoring.ts`; ⚠ no covering tests found

<sub>derived 2026-07-08 · arc=3 commits · files=3 · lessons=17</sub>
<!-- okf:auto-end -->

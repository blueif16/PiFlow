---
type: subsystem
key: runtime-core
title: Runtime core (the execution spine — template → WorkflowSpec → DAG → one pi per node → artifacts on disk)
description: How an authored template is loaded into a WorkflowSpec, compiled into a topologically-ordered DAG, and run by an engine that spawns ONE headless pi agent per node, coordinating every node through the filesystem and verifying each by host-stat of its declared artifacts.
resource: packages/core/src/runner/runner.ts
aliases: [runWorkflow, runFromTemplate, loadTemplate, compile, runNode, WorkflowSpec, Workflow, NodeSpec, DAG, stagesOf, inferEdges, defaultPiCommand, instantiateRun, runner, filesystem-as-contract, one-pi-per-node]
seeds: [packages/core/src/workflow/template/loader.ts, packages/core/src/dag.ts, packages/core/src/contract.ts, packages/core/src/runner/entry.ts, packages/core/src/runner/runner.ts, packages/core/src/runner/node-lifecycle.ts, packages/core/src/runner/command.ts, packages/core/src/workflow/template/instantiate.ts, packages/core/src/types.ts]
symbols: [loadTemplate, toNodeIntent, compile, inferEdges, stagesOf, runFromTemplate, instantiateRun, runWorkflow, runNode, finishNode, defaultPiCommand, emitMarkers, Workflow, NodeSpec]
tags: [runtime, runner, dag, lifecycle, core, template, filesystem-as-contract]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
An authored TEMPLATE (`meta.json` + `nodes/<id>/{node.json,prompt.md}`) is read by `loadTemplate` (the
fail-closed §8 gate): it scans each node, `toNodeIntent` maps it to a `NodeIntent` (rendering the prompt's
DRIVER-* contract markers via the `contract.ts` codec), runs the static checks, and returns a flat
`WorkflowSpec`. `compile` (dag.ts) materializes each intent into a dense `NodeSpec`, `inferEdges` derives
data-flow edges from each node's `io.reads ⋈ io.produces`, and `stagesOf` groups nodes into topological
stages (parallel lanes per level), yielding a `Workflow`. `runFromTemplate` is the join: load → `instantiateRun`
(materialize `${RUN}/.pi/nodes/<id>/`) → `compile` → `runWorkflow`. `runWorkflow` walks stages in order
(Promise.all per stage, concurrency-capped, HALT on first error/blocked). Each node runs through `runNode`:
create sandbox → stage `io.reads` in → write the prompt+markers → `defaultPiCommand` builds the headless
`pi -p --mode json` invocation → `execRunner` spawns ONE pi → collect output back to the host run dir →
VERIFY by host-stat of declared artifacts (+ schema/checks/return gates) → `finishNode` stamps the verdict
into `.pi/run.json`. Nodes coordinate ONLY through files on disk.

# Anchors
AUTHORED TEMPLATE → LOAD
- `packages/core/src/workflow/template/loader.ts:195` — `loadTemplate` — fail-closed scan+check → `WorkflowSpec`
- `packages/core/src/workflow/template/loader.ts:96` — `toNodeIntent` — authored `TemplateNode` → runtime `NodeIntent`
WORKFLOWSPEC → DAG (topo-order)
- `packages/core/src/dag.ts:172` — `compile` — `WorkflowSpec` → dense `Workflow` (or `WorkflowError`)
- `packages/core/src/dag.ts:64` — `inferEdges` — data-flow edges from `io.reads ⋈ io.produces`
- `packages/core/src/dag.ts:100` — `stagesOf` — longest-path topological stages (parallel lanes per level)
- `packages/core/src/types.ts:982` — `Workflow` — the compiled `{meta, nodes, stages, edges}`
TEMPLATE-RUN JOIN
- `packages/core/src/runner/entry.ts:150` — `runFromTemplate` — load → instantiate → compile → run
- `packages/core/src/workflow/template/instantiate.ts:98` — `instantiateRun` — materialize `${RUN}/.pi/nodes/<id>/`
PER-NODE RUNNER EXEC
- `packages/core/src/runner/runner.ts:315` — `runWorkflow` — stage-by-stage loop, parallel lanes, HALT-on-failure
- `packages/core/src/runner/node-lifecycle.ts:80` — `runNode` — create→stage→exec→collect→verify→finish (one pi)
- `packages/core/src/runner/command.ts:69` — `defaultPiCommand` — builds the headless `pi -p --mode json` invocation
ARTIFACTS ON DISK
- `packages/core/src/runner/node-lifecycle.ts:490` — artifact host-stat — a node is `ok` only if declared artifacts exist
- `packages/core/src/runner/node-lifecycle.ts:795` — `finishNode` — stamp verdict → `.pi/run.json` + journal entry

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: `runNode`/`finishNode` no longer live in `runner.ts` (the §2.1 split moved them to `runner/node-lifecycle.ts`; runner.ts only re-exports them) — the per-node lifecycle is in node-lifecycle.ts, NOT the run loop. The compiled `Workflow`/`NodeSpec`/`Stage`/`Edge` shapes are all in `types.ts` (982/17/967/975), not in dag.ts.

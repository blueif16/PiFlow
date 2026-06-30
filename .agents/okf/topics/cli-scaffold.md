---
type: subsystem
key: cli-scaffold
title: cli-scaffold (piflowctl — the thin CLI accessor + the new/add-node authoring path)
description: How `piflowctl` dispatches a flat argv to a subcommand — `new`/`add-node` EMIT meta.json + node.json + (create-if-absent) memory.md + code-map.md from flags, leaving prose to the agent, and `run` drives a template through the core runner.
resource: packages/cli/src/scaffold.ts
aliases: [piflowctl, scaffold, new, add-node, init, run, cli, scaffoldNew, scaffoldAddNode, buildNode]
seeds: [packages/cli/src/cli.ts, packages/cli/src/scaffold.ts, packages/cli/src/run.ts, packages/cli/src/index.ts, packages/core/src/memory/seed.ts, packages/core/src/code-map.ts, packages/core/src/workflow/template/loader.ts, packages/core/src/runner/entry.ts]
symbols: [runNewCli, runAddNodeCli, scaffoldNew, scaffoldAddNode, buildMeta, buildNode, seedSystemMemory, seedNodeMemory, seedNodeCodeMap, runTemplate, parseRunArgs]
tags: [cli, scaffold, lifecycle, authoring, runner, memory]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
The `piflowctl` bin (`packages/cli/src/cli.ts`) is one front door: a flat-argv `switch` routes `new`,
`add-node`, `memory`, `run`, etc. (after a best-effort `ensurePiflowHome()` bootstrap). AUTHORING is a
deterministic emit-from-flags, never an edit: `runNewCli` → `scaffoldNew` calls `buildMeta` and writes
`meta.json`; `runAddNodeCli` parses the GNU-ish argv (each value-flag repeatable) and `scaffoldAddNode`
calls `buildNode` to write one schema-valid `nodes/<id>/node.json` (id/phase/deps/contract spine + only the
optional blocks given; derive hooks fold into the canonical `op[]`). Both SEED the optimizer-facing memory
legs create-if-absent via core's `seedSystemMemory` / `seedNodeMemory` / `seedNodeCodeMap` (memory.md,
code-map.md) and NEVER touch the node's `prompt.md` — that prose is the agent's, written fresh. `workflow.json`
is never scaffolded; `loadTemplate` (the §8 compile gate) re-derives stages+edges. `runRunCli` → `parseRunArgs`
→ `runTemplate` then drives it: dry-run prints realized `pi` commands; a live run routes through core
`runFromTemplate` (loadTemplate → instantiateRun → compile → runWorkflow), threading args/sandbox/provider.

# Anchors
BIN
- `packages/cli/src/cli.ts:166` — `main()` switch — the flat-argv subcommand dispatcher (new/add-node/memory/run/…)
- `packages/core/src/cli.ts:38` — second bin — a SEPARATE `@piflow/core` entry that handles only `logs` (re-exported into the one `piflowctl` bin)
NEW
- `packages/cli/src/scaffold.ts:415` — `runNewCli` — parses argv, calls `scaffoldNew`
- `packages/cli/src/scaffold.ts:198` — `scaffoldNew` — writes meta.json (via `buildMeta`) + seeds system `memory.md`
ADD-NODE
- `packages/cli/src/scaffold.ts:435` — `runAddNodeCli` — parses the repeatable flags, calls `scaffoldAddNode`
- `packages/cli/src/scaffold.ts:124` — `buildNode` — PURE: id/phase/deps/contract + optional blocks + derives folded into `op[]`
- `packages/cli/src/scaffold.ts:236` — `seedNodeMemory`/`seedNodeCodeMap` — seed memory.md + code-map.md create-if-absent (never clobbers prompt.md)
RUN
- `packages/cli/src/run.ts:354` — `runTemplate` — dry-run (print commands) vs live (`runFromTemplate`); injectable `RunDeps` seam
- `packages/core/src/runner/entry.ts:150` — `runFromTemplate` — the core template-run join the CLI delegates to

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the `--agent-type` flag is ABSENT — the scaffolder exposes NO `--agent-type` flag and `buildNode`/`NodeOpts` emits NO `agentType` field at all (the only `agentType` mention in `packages/cli/src/` is `run.ts:468`, a pass-through of an already-present `n.agentType` into the dry-run status). A node carries `agentType` only if hand-written into node.json (the schema field exists at `node.schema.ts:55`); the preset binding via `mergePreset` lives in core/observe (see `base-agent-types`), NOT in this CLI. The repo's own `docs/research/memory/code-understanding-and-anti-drift.md:48` flags this exact memory-vs-trace drift.

---
type: subsystem
key: memory-leg
title: Memory layer (the two legs — Leg A self/history · Leg B world/code)
description: How each node gets two optimizer-facing markdown surfaces — memory.md (standing behavior + failure lessons) and code-map.md (a Tier-0 OKF slice of its scope) — seeded PURE create-if-absent by the scaffolder, never injected into the node's runtime prompt, intended only for the Hermes optimizer to read and update.
resource: packages/core/src/memory/skeleton.ts
aliases: [memory.md, code-map, code-map.md, memory-leg, buildNodeMemory, buildSystemMemory, buildNodeCodeMap, seedNodeMemory, seedNodeCodeMap, Leg A, Leg B, hermes, optimizer-facing, self/history, world/code]
seeds: [packages/core/src/memory/skeleton.ts, packages/core/src/memory/seed.ts, packages/core/src/memory/index.ts, packages/core/src/code-map.ts, packages/core/src/index.ts, packages/cli/src/scaffold.ts, packages/cli/src/cli.ts]
symbols: [buildNodeMemory, buildSystemMemory, buildNodeCodeMap, seedNodeMemory, seedSystemMemory, seedNodeCodeMap, writeIfAbsent, scaffoldMemory]
tags: [memory, optimizer, scaffold, core, cli, self-correction]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
Each node carries two optimizer-facing markdown legs. Leg A (self/history) is `memory.md`: standing
behavior + generalized failure LESSONS + a `git log --grep '^skillsys(<id>)'` pointer, built PURE from the
id by `buildNodeMemory` (per-node) and `buildSystemMemory` (the template reconcile summary). Leg B
(world/code) is `code-map.md`: one Tier-0 OKF reference slice of the product code in the node's scope, built
by `buildNodeCodeMap`. The seeds are written create-if-absent by `seedNodeMemory` / `seedSystemMemory` /
`seedNodeCodeMap`, each guarded by `writeIfAbsent` so a re-seed NEVER clobbers curated content (memory
accumulates). The CLI scaffolder wires this in: `scaffoldNew` seeds the system `memory.md`; `scaffoldAddNode`
seeds the node's `memory.md` + `code-map.md`; `scaffoldMemory` backfills an existing template (the
`piflowctl memory scaffold` engine). All six builders/seeders are lifted to the `@piflow/core` root. The legs
are OPTIMIZER-FACING — never injected into a node's runtime prompt (a node must not see its own failure
history). The intended consumer is the Hermes optimizer; today it is not yet wired (see DRIFT NOTE).

# Anchors
DEFINED
- `packages/core/src/memory/skeleton.ts:15` — `buildNodeMemory()` — PURE per-node `memory.md` seed (Leg A)
- `packages/core/src/memory/skeleton.ts:45` — `buildSystemMemory()` — PURE template reconcile-summary seed (Leg A)
- `packages/core/src/code-map.ts:35` — `buildNodeCodeMap()` — PURE per-node Tier-0 OKF slice seed (Leg B)
- `packages/core/src/memory/seed.ts:17` — `writeIfAbsent()` — create-if-absent guard (never clobbers curated content)
SEEDED (at scaffold time)
- `packages/cli/src/scaffold.ts:206` — `scaffoldNew` → `seedSystemMemory` — seeds the template's system `memory.md`
- `packages/cli/src/scaffold.ts:236` — `scaffoldAddNode` → `seedNodeMemory` + `seedNodeCodeMap` (line 237) — seeds both legs per node
- `packages/cli/src/scaffold.ts:247` — `scaffoldMemory()` — backfill engine for `piflowctl memory scaffold`
CONSUMED
- (none) — no runtime/optimizer reader exists yet; `optimize/triage.ts:14` names Leg-A `memory.md` as a DEFERRED SKILL signal, but reads neither file. Leg B has NO reader at all.

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the layer is SEED-ONLY today — both legs are written but nothing reads them. Leg A's intended reader (the Hermes optimizer/triage SKILL lane) is explicitly DEFERRED in `optimize/triage.ts`; Leg B has NO reader designed yet (the optimizer is the intended consumer). `index.ts` is currently marked `// STUB — RED phase` though the facade is fully wired and root-exported — verify that label is still accurate.

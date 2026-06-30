---
type: subsystem
key: observe
title: Observe (the one rich run-view — read → distill → RunView → viewers, live via SSE)
description: How a raw `.pi/` run dir becomes the ONE enriched run-view every viewer renders — folded by readRunModel/buildRunView (replaying events.jsonl through the shared distiller, stamping pi-native context windows), exposed as the RunView/RunModel contract, consumed by CLI/TUI/GUI, and streamed live by watchRun over SSE.
resource: packages/core/src/observe/runView.ts
aliases: [observe, run-view, runView, buildRunView, readRunModel, watchRun, RunView, RunModel, createNodeAccumulator, distill, telemetry, projectRunDigest, single data path, one data path, SSE, events.jsonl, io.json]
seeds: [packages/core/src/observe/read.ts, packages/core/src/observe/runView.ts, packages/core/src/observe/distill.ts, packages/core/src/observe/watch.ts, packages/core/src/observe/types.ts, packages/core/src/observe/telemetry.ts, packages/core/src/observe/models.ts, gui/vite.config.ts, packages/cli/src/status.ts, tui/adapt.mjs]
symbols: [readRunModel, buildRunView, createNodeAccumulator, watchRun, deriveStatus, contextWindowFor, projectRunDigest, telemetryStream, RunView, RunModel]
tags: [observe, run-view, lifecycle, core, gui, tui, cli, telemetry, sse]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
A run writes the engine-owned `.pi/` tree: `run.json` (statuses), per-node `io.json` (the declared
reads/writes ledger), and per-node `events.jsonl` (the pi event firehose). `observe` folds this into ONE
view two ways. The LEAN snapshot `readRunModel` (read.ts) reconstructs stages from the last parallel
barrier and re-derives each node's status VERIFIED-not-trusted via `deriveStatus` (a claimed-complete node
with a missing artifact downgrades to `blocked`), wiring io-derived edges (A wrote a path B read back). The
RICH `buildRunView` (runView.ts) is a superset: it REPLAYS each `events.jsonl` through the shared reducer
`createNodeAccumulator` (distill.ts) for model/provider, tokens/contextPeak, toolBreakdown, timeline, and
scope-bucketed reads, stamps `contextWindow` from pi's native registry (`contextWindowFor`, models.ts),
and prefers the run-local resolved `workflow.json` for stages+edges. Both emit the `RunView`/`RunModel`
contract (types.ts). Consumers render it WITHOUT re-deriving: CLI `renderStatus` (status.ts), TUI `adapt.mjs`,
GUI middleware (vite.config.ts). Live, `watchRun` (watch.ts) tails the same files and yields snapshot →
node-status/node-event/done deltas, which the GUI middleware relays as SSE. `telemetry.ts` projects the
view into an agent-facing RunDigest.

# Anchors
RAW `.pi` → READ (lean snapshot)
- `packages/core/src/observe/read.ts:104` — `readRunModel()` — folds run.json + io.json into RunModel
- `packages/core/src/observe/read.ts:60` — `deriveStatus()` — verified-not-trusted status downgrade
DISTILL (rich per-node reducer)
- `packages/core/src/observe/distill.ts:120` — `createNodeAccumulator()` — the shared events.jsonl reducer
- `packages/core/src/observe/models.ts:66` — `contextWindowFor()` — pi-native context-window stamp
RUNVIEW (the contract + builder)
- `packages/core/src/observe/runView.ts:212` — `buildRunView()` — superset run-view (replays events, prefers workflow.json DAG)
- `packages/core/src/observe/types.ts:91` — `RunModel` — the shared snapshot contract (stages+edges+nodes)
LIVE (stream + SSE)
- `packages/core/src/observe/watch.ts:62` — `watchRun()` — yields snapshot then status/event/done deltas
- `gui/vite.config.ts:138` — GUI middleware relays `watchRun` as a `text/event-stream` SSE feed
CONSUMED
- `packages/cli/src/status.ts:69` — CLI renders a `readRunModel` snapshot (thin renderer)

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the prompt's "telemetry.ts" is a PROJECTION (a lens over the run-view: `projectRunDigest`:294 / `telemetryStream`:363), NOT a second collector; the GUI's on-demand run-view is the OTHER live path (`buildRunView` at gui/vite.config.ts:196), distinct from the SSE `watchRun` feed; the TUI consumes via `adapt.mjs` (overlays the rich RunView onto a readRunModel snapshot), not a direct core import.

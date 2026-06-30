---
type: subsystem
key: gui
title: GUI run-view viewer (index → flowmap → view-mode overlays → companion bridge)
description: The static React/Vite viewer — Vite dev middleware serves the global ~/.piflow index + distills each run's real .pi/ into a RunView, toFlowGraph lays it out, nodes render with view-mode overlays, and the companion subscribes to a live SSE bridge over observe.watchRun. A pure projection, never a producer.
resource: gui/src/data/runView.ts
aliases: [gui, NodeHud, flowmap, toFlowGraph, companion, run-view, viewer, runStream, NodeModeStrip, watchRun, vite-middleware]
seeds: [gui/vite.config.ts, gui/src/data/runView.ts, gui/src/data/runStream.ts, gui/src/data/runIndex.ts, gui/src/components/WorkflowCanvas.tsx, gui/src/components/WorkflowNode.tsx, gui/src/components/NodeModeStrip.tsx, gui/src/components/Companion.tsx]
symbols: [toFlowGraph, loadRunView, loadIndex, useRunStream, liveFlowGraph, NodeModeStrip, NodeHud, watchRun]
tags: [gui, viewer, observe, run-view, lifecycle, companion]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
The GUI is a static viewer: it OWNS no data, it projects what the dev middleware distills on demand. SOURCE
— `gui/vite.config.ts` registers `/__piflow/*` plugins that read the GLOBAL `~/.piflow` registry/index LIVE
(never a committed `gui/public/index.json`): `piflowRunView` calls core's `buildRunView(runDir)` to distill a
run's real `.pi/`, `piflowAgents` reads the preset catalog, `piflowRunStream` pipes `observe.watchRun`. The
canvas (`WorkflowCanvas`) calls `loadIndex()` (`/__piflow/index.json`) → `pickCurrentRun`, then
`loadRunView` + `loadAgentCatalog`. SHAPE→RENDER — `toFlowGraph(view, catalog)` maps each `RunViewNode` onto a
positioned `FlowNode` (resolving `agentType`→icon), `WorkflowNode` draws the card and paints a `NodeModeStrip`
overlay per active `ViewMode` (status/model/artifacts/basis); clicking opens `NodeHud` off `rv`. COMPANION —
`useRunStream` opens ONE `EventSource` to `/__piflow/stream/<run>`, folds SSE frames (snapshot→node-event→done)
into live `richByNode`; `liveFlowGraph` renders a running run, and `Companion` reads the shared stream plus its
own control-session channel.

# Anchors
SOURCE
- `gui/vite.config.ts:165` — `piflowRunView()` — `/__piflow/run-view/<run>` distills real `.pi/` via core `buildRunView`
- `gui/vite.config.ts:90` — `piflowRunStream()` — `/__piflow/stream/<run>` SSE feed of `observe.watchRun`
- `gui/src/data/runIndex.ts:60` — `loadIndex()` — reads the global `~/.piflow` index via `/__piflow/index.json`
SHAPE
- `gui/src/data/runView.ts:105` — `loadRunView()` — fetches the distilled RunView (the GUI's real-data contract)
- `gui/src/data/runView.ts:373` — `toFlowGraph()` — RunView → positioned FlowNodes + collapsed edges (resolves agentType icon)
RENDER
- `gui/src/components/WorkflowCanvas.tsx:139` — index→view→graph wiring (loadRunView+loadAgentCatalog→toFlowGraph)
- `gui/src/components/WorkflowNode.tsx:274` — paints `NodeModeStrip` under the card when a view-mode is active
- `gui/src/components/NodeModeStrip.tsx:31` — `NodeModeStrip()` — the per-node view-mode overlay (status/model/basis)
COMPANION
- `gui/src/data/runStream.ts:103` — `useRunStream()` — ONE EventSource over the SSE bridge → live model + richByNode

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: the memory's "view-mode overlays (T/M/A)" is partly stale — `VIEW_MODES` (ViewModeContext.tsx:34) keys are t/m/a/**b**/f/c (status·model·artifacts·basis·fusion·compose), and fusion/compose are INTERACTIVE editors (preview re-expand · template `op[]` write-back), not passive info strips.

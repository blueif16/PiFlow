---
type: subsystem
key: base-agent-types
title: Base agent types (agentType presets — define → derive → render)
description: How a node adopts a base agent — a preset id on node.json, expanded PURE at author-time by mergePreset into concrete tools+prompt, carried as a label through the runner → observe → resolved to icon branding in the GUI.
resource: packages/core/src/workflow/agent-preset.ts
aliases: [agentType, agent-type, mergePreset, AgentPreset, preset, base agent, FUSION_PRESETS, loadAgentPreset, agent-preset]
seeds: [packages/core/src/workflow/agent-preset.ts, packages/core/src/workflow/fusion/presets.ts, packages/core/src/workflow/template/schema/node.schema.ts, packages/core/src/workflow/template/loader.ts, packages/core/src/runner/node-lifecycle.ts, packages/core/src/observe/runView.ts, gui/src/data/runView.ts, gui/src/components/NodeModeStrip.tsx]
symbols: [mergePreset, AgentPreset, loadAgentPreset, FUSION_PRESETS, toFlowGraph]
tags: [agent-presets, lifecycle, core, observe, gui]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
A node adopts a base agent by declaring `agentType: "<preset-id>"` in `node.json`. `mergePreset()`
(PURE, exhaustively testable) expands the preset at AUTHOR time into the node's concrete `tools`
(preset ∪ node, deny wins) and `prompt` (role first, task appended), and stamps `agentType = preset.id`.
The preset SHAPE (id, display icon/label/color, skills, tools, prompt) is `AgentPreset`, loaded read-only
from `~/.piflow/agents/<id>.md` via `loadAgentPreset` (or the built-in `FUSION_PRESETS` for fusion nodes).
At run time the label rides verbatim: the template `loader` carries it onto `NodeIntent`, `node-lifecycle`
stamps it into `NodeConfig` and the status record; `observe` passes it into the run-view; and the GUI's
`toFlowGraph` resolves `agentType` against the `AgentCatalog` to fetch the icon/branding, rendered as the
base-agent chip in `NodeModeStrip`. The slice is OPTIMIZER-FACING — never injected into the node's prompt.

# Anchors
DEFINED
- `packages/core/src/workflow/agent-preset.ts:23` — `AgentPreset` — the canonical preset shape
- `packages/core/src/workflow/agent-preset.ts:64` — `mergePreset()` — PURE author-time expansion (tools ∪, role+task, sets agentType)
- `packages/core/src/workflow/fusion/presets.ts:24` — `FUSION_PRESETS` — built-in judge/obligations presets
DERIVED at workflow-start
- `packages/core/src/workflow/template/schema/node.schema.ts:55` — `agentType` field — declares the preset id on a node
- `packages/core/src/workflow/agent-preset.ts:214` — `loadAgentPreset()` — read-only load from ~/.piflow/agents/<id>.md
CONSUMED
- `packages/core/src/workflow/template/loader.ts:159` — carries agentType onto `NodeIntent`
- `packages/core/src/runner/node-lifecycle.ts:778` — stamps `node.agentType` into `NodeConfig` at run time
PASSED THROUGH
- `packages/core/src/observe/runView.ts:291` — agentType passthrough into `RunViewNode`
RENDERED
- `gui/src/data/runView.ts:371` — `toFlowGraph()` resolves agentType → icon/color/label off `AgentCatalog`
- `gui/src/components/NodeModeStrip.tsx:85` — renders the base-agent chip

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: presets are NOT in `core/src/seeds/` (memory said so; that dir is just calc.ts) — real home is `fusion/presets.ts` + `~/.piflow/agents/`; the claimed `--agent-type` CLI flag was NOT found (only the node.json field) — verify.

---
type: subsystem
key: observe
title: Observe (the one rich run-view — read → distill → RunView → viewers, live via SSE)
description: How a raw `.pi/` run dir becomes the ONE enriched run-view every viewer renders — folded by readRunModel/buildRunView (replaying events.jsonl through the shared distiller, stamping pi-native context windows + the deriveNode display zones), exposed as the RunView/RunModel contract, consumed by CLI/TUI/GUI, and — since P2 — streamed live by watchRun as the SINGLE ENRICHED source: an incremental server-side fold (assembleNode/nodeTokenSpine/deriveNode over a non-destructive acc.snapshot) that pushes node-enriched deltas over SSE, so the live graph ≡ /run-view and the GUI computes nothing.
resource: packages/core/src/observe/runView.ts
aliases: [observe, run-view, runView, buildRunView, readRunModel, watchRun, RunView, RunModel, createNodeAccumulator, distill, deriveNode, NodeDerived, nodeTokenSpine, assembleNode, resolveStructure, snapshot, node-enriched, telemetry, projectRunDigest, single data path, one data path, single source, SSE, events.jsonl, io.json, cost, costScalar, tokens, usage, billable, RunTokens]
seeds: [packages/core/src/observe/read.ts, packages/core/src/observe/runView.ts, packages/core/src/observe/distill.ts, packages/core/src/observe/derive.ts, packages/core/src/observe/structure.ts, packages/core/src/observe/watch.ts, packages/core/src/observe/types.ts, packages/core/src/observe/telemetry.ts, packages/core/src/observe/models.ts, packages/server/src/handlers.ts, gui/vite.config.ts, packages/cli/src/status.ts, tui/adapt.mjs]
symbols: [readRunModel, buildRunView, createNodeAccumulator, deriveNode, nodeTokenSpine, assembleNode, resolveStructure, watchRun, deriveStatus, contextWindowFor, projectRunDigest, telemetryStream, RunView, RunModel]
tags: [observe, run-view, lifecycle, core, gui, tui, cli, telemetry, sse]
timestamp: 2026-07-01
---

# Why / how it works (the lifecycle, end to end)
A run writes the engine-owned `.pi/` tree: `run.json` (statuses), per-node `io.json` (the declared
reads/writes ledger), and per-node `events.jsonl` (the pi event firehose). `observe` folds this into ONE
view two ways. The LEAN snapshot `readRunModel` (read.ts) re-derives each node's status VERIFIED-not-trusted
via `deriveStatus` (a claimed-complete node with a missing artifact downgrades to `blocked`) and resolves
stages/edges via the SHARED `resolveStructure` (structure.ts: `.pi/workflow.json` → template → phase grouping).
The RICH `buildRunView` (runView.ts) is a superset: it REPLAYS each `events.jsonl` through the shared reducer
`createNodeAccumulator` (distill.ts) for model/provider, tokens/contextPeak, toolBreakdown, timeline, and
scope-bucketed reads, stamps `contextWindow` from pi's native registry (`contextWindowFor`, models.ts), and
stamps the per-node DISPLAY projection `deriveNode` (derive.ts — cache/tool-error/dominance/context/time/retries
zones + topTools + unified outputs, computed ONCE so every view renders identical numbers). Its per-node build
is factored into two pure functions the live path shares: `nodeTokenSpine` (the `rec.usage`-first-vs-event-
replay token precedence — the AgentDriver seam) and `assembleNode` (the whole per-node build, then
`node.derived = deriveNode(node)`). Both emit the `RunView`/`RunModel` contract (types.ts). Consumers render it
WITHOUT re-deriving: CLI `renderStatus` (status.ts), TUI `adapt.mjs`, GUI. Live, `watchRun` (watch.ts) is the
SINGLE ENRICHED source (P0a–P5): it tails events incrementally (one long-lived accumulator/node) and FOLDS the
SAME assembly server-side over the NON-DESTRUCTIVE `acc.snapshot()` (never `finalize()`, which corrupts a live
accumulator), emitting a `node-enriched` delta carrying the WHOLE re-assembled node on a stable fold-signature
change (clock excluded). The GUI renders the enriched `live.model` and computes nothing; the old 3s `/run-view`
+ `/run-digest` replay polls are demoted to one-shot loads + a reconcile net (gui `runStream`/`runView`/
`liveSource`; DR6 heals drift on tab-return). `telemetry.ts` projects the view into an agent-facing RunDigest.

# Anchors
RAW `.pi` → READ (lean snapshot)
- `packages/core/src/observe/read.ts:82` — `readRunModel()` — folds run.json + io.json into RunModel (resolveStructure for stages/edges)
- `packages/core/src/observe/read.ts:62` — `deriveStatus()` — verified-not-trusted status downgrade
DISTILL (rich per-node reducer)
- `packages/core/src/observe/distill.ts:198` — `createNodeAccumulator()` — the shared events.jsonl reducer (per-node tokens + cost + contextPeak)
- `packages/core/src/observe/distill.ts:271` — `snapshot()` — the NON-DESTRUCTIVE live twin of `finalize()` (frozen copy, open spans read-only) — what the live fold consumes
- `packages/core/src/observe/distill.ts:281` — `finalize()` — the DESTRUCTIVE terminal read (synth-closes open spans); buildRunView only
- `packages/core/src/observe/distill.ts:169` — `costScalar` — coerces pi's `usage.cost` into the per-node cost tally (the COST number the GUI shows is COMPUTED here, not in gui)
- `packages/core/src/observe/models.ts:66` — `contextWindowFor()` — pi-native context-window stamp
RUNVIEW (the contract + builder + the SHARED assembly)
- `packages/core/src/observe/runView.ts:438` — `buildRunView()` — superset run-view (replays events, prefers workflow.json DAG, stamps deriveNode)
- `packages/core/src/observe/runView.ts:313` — `nodeTokenSpine()` — the `rec.usage`-first-vs-event-replay token precedence (the AgentDriver seam — Thrust 3)
- `packages/core/src/observe/runView.ts:343` — `assembleNode()` — the whole per-node build (reads/writes/tokens/spine), then `node.derived = deriveNode(node)` — SHARED by buildRunView + watchRun
- `packages/core/src/observe/types.ts:142` — `RunModel` — the shared snapshot contract (stages+edges+nodes)
- `packages/core/src/observe/types.ts:177` — the `node-enriched` `RunUpdate` kind (the FULL node delta — must also be in cli/remote.ts RUN_UPDATE_KINDS)
DERIVE (the display projection) + STRUCTURE (parity)
- `packages/core/src/observe/derive.ts:84` — `deriveNode()` — cache/tool-error/dominance/context/time/retries zones + topTools + unified outputs (the ONE threshold oracle)
- `packages/core/src/observe/structure.ts:70` — `resolveStructure()` — the ONE stage/edge resolver both readers share (workflow.json → template → phase)
LIVE (the single enriched SSE source)
- `packages/core/src/observe/watch.ts:196` — `watchRun()` — incremental server-side fold; yields snapshot + node-status/node-event/**node-enriched**/done
- `packages/core/src/observe/watch.ts:218` — `acc.snapshot(rec)` fold — NON-DESTRUCTIVE live read → assembleNode
- `packages/core/src/observe/watch.ts:319` — `yield {kind:'node-enriched'}` — the full re-assembled node on a fold-signature change
- `packages/server/src/handlers.ts:35` — `piflowRunStream` — `GET /__piflow/stream/<run>` pipes the exact `watchRun` stream as SSE (feeds it the SAME historyDirs/workspaceRoot as /run-view)
- `packages/server/src/handlers.ts:103` — `piflowRunView` — `GET /__piflow/run-view/<run>` = one-shot `buildRunView` (loads + the DR6 reconcile net)
PROJECT + CONSUMED
- `packages/core/src/observe/telemetry.ts:377` — `projectRunDigest()` — the agent-facing RunDigest lens over the view (NOT a second collector)
- `packages/cli/src/status.ts:35` — `renderStatus()` — CLI renders a `readRunModel` snapshot (thin renderer; `:87` reads it)
- `gui/vite.config.ts:21` — the Vite dev middleware wires `@piflow/server` `createApiMiddleware` (the SSE + run-view handlers)

# Freshness (anti-drift)
anchors ✓ (re-verified 2026-07-01 after the SSE single-source landing) · scope = the seeds above · re-derive when they change · DRIFT NOTES: (1) the SSE relay + on-demand run-view moved OUT of `gui/vite.config.ts` INTO `@piflow/server` `handlers.ts` (`piflowRunStream`/`piflowRunView`); the Vite config now only wires that middleware. (2) `telemetry.ts` is a PROJECTION (`projectRunDigest`/`telemetryStream`), NOT a second collector. (3) the LIVE graph now comes from the enriched `watchRun` fold (node-enriched), NOT a re-poll — the GUI transport is a client flag (`gui/src/data/liveSource.ts`), the reconcile net + `runViewToLiveModel` live in gui. (4) TUI consumes via `adapt.mjs` (overlays the rich RunView onto a readRunModel snapshot), not a direct core import. Full record: `docs/telemetry.md` + `docs/design/observe-live-sse-single-source.md`.

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/observe/read.ts` | ✓ |
| `packages/core/src/observe/runView.ts` | ✓ |
| `packages/core/src/observe/distill.ts` | ✓ |
| `packages/core/src/observe/derive.ts` | ✓ |
| `packages/core/src/observe/structure.ts` | ✓ |
| `packages/core/src/observe/watch.ts` | ✓ |
| `packages/core/src/observe/types.ts` | ✓ |
| `packages/core/src/observe/telemetry.ts` | ✓ |
| `packages/core/src/observe/models.ts` | ✓ |
| `packages/server/src/handlers.ts` | ✓ |
| `gui/vite.config.ts` | ✓ |
| `packages/cli/src/status.ts` | ✓ |
| `tui/adapt.mjs` | ✓ |

### Evolution arc

- `e4902c5` 2026-06-23 — feat(cli): @piflow/cli status + watch over the .pi/ run layout
- `f1b3044` 2026-06-23 — feat(core): run-observability source — readRunModel + watchRun
- `dc60d9e` 2026-06-23 — refactor(cli): consume @piflow/core/observe — delete the bespoke .pi/ readers
- `5b388de` 2026-06-23 — feat(gui): import flowmap-design-system as gui/
- `4c0d5eb` 2026-06-24 — feat(gui): persistent top-right MenuBar + workspace/run switcher
- `d0c0f63` 2026-06-24 — feat(gui): SSE bridge for live run telemetry
- `2d97699` 2026-06-24 — feat(gui): live watch index — recompute on every request + client poll
- `34ec7f4` 2026-06-24 — feat(core/observe): shared rich run-view distiller + pi-native model registry
- `8c2b1dd` 2026-06-24 — feat(gui): single data path — distill any run's .pi via the shared core builder
- `fb423c2` 2026-06-24 — feat(core/observe): per-node retries · stopReason/truncation · thinkingChars intakes
- `75e14b1` 2026-06-24 — fix(core/observe): derive run-view DAG edges from io.json ledger ∪ events
- `7be84b7` 2026-06-24 — feat(core/observe): render the DAG from the declared template topology
- `9b6e226` 2026-06-24 — feat(core): runs record their profile-resolved DAG; viewer renders it
- `d768a9d` 2026-06-24 — feat(gui): render any node file from disk via a read-back endpoint
- `32f2f29` 2026-06-24 — fix(core/observe): resolve every run-view file path to one uniform absolute form
- `1a09c9e` 2026-06-24 — feat(gui): navigator shows the run's full on-disk file tree
- `cfcb972` 2026-06-24 — refactor(tui): move @piflow/tui to top-level beside gui
- `067b365` 2026-06-25 — feat(core): add the G5 human-checkpoint NODE KIND (schema → spec) + awaiting-input
- `895da61` 2026-06-25 — feat(core): surface the G5 checkpoint through the ONE observe run-view stream
- `e87b844` 2026-06-25 — feat(gui): the G5 checkpoint reply COURIER — POST /__piflow/checkpoint/<run>
- `5604721` 2026-06-25 — feat(core): carry agentType label through template → observe (G6)
- `22cb89d` 2026-06-25 — feat(gui): render agent-preset icons on the node chip (G6)
- `e78f94c` 2026-06-26 — refactor(cli): rename global bin piflow → piflowctl
- `5607be7` 2026-06-26 — fix(observe,gui): render live elapsed for in-flight runs and nodes
- `9636137` 2026-06-26 — feat(core): withNodeFusion toggle + previewView projection
- `99a14f7` 2026-06-26 — feat(gui): /__piflow/preview endpoint — SDK-driven fusion DAG preview
- `dde5002` 2026-06-26 — feat(gui): save-to-run — bake a fusion edit into THIS run
- `2af0b28` 2026-06-26 — feat(observe): capture loop signals in the rich reducer
- `a300f56` 2026-06-26 — feat(observe): telemetry projection — agent-facing lens over the run-view
- `beb606f` 2026-06-27 — feat(gui): control-session bridge — spawn pi --mode rpc + stdio framing
- `5cb0aa9` 2026-06-27 — feat(gui): control-session conversation history — continue-by-click + new chat
- `a53ec10` 2026-06-27 — feat(core): mirror per-node config + run sandbox through observe
- `cbecd7b` 2026-06-28 — feat(gui): drag-to-compose write-back — config as source of truth (SA-E)
- `22523e9` 2026-06-29 — Merge branch 'main' into worktree-feat+expert-representations
- `48b32d6` 2026-06-29 — refactor(tui): extract pure view adapters into adapt.mjs + adaptRunView
- `c7f15f7` 2026-06-30 — fix(gui): scope `piflowctl gui` to the launched project, not the global registry
- `cc65e95` 2026-06-30 — refactor(core): lift project-scope resolution into @piflow/core (shared)
- `10ea496` 2026-07-01 — feat(server): @piflow/server + piflowctl serve — host the control plane (control API + GUI) on any host
- `bbc1126` 2026-07-01 — feat(server): POST /api/runs/start — launch a run (start agents) from the console
- `b75235d` 2026-07-01 — feat(server): P5 template allow-listing on POST /api/runs/start
- `091a49a` 2026-07-01 — feat(server): P6 migration endpoints — freeze / bundle / adopt
- `e7a62b2` 2026-07-01 — feat(cli): P7 — the active context redirects observe/start to a remote serve
- `d529c10` 2026-07-01 — feat(cli): piflowctl context migrate — one-click upload/download (P6)
- `1933da4` 2026-07-01 — feat(server): GET /api/contexts + POST /api/migrate — server-orchestrated run migration (D1)
- `b0e6ff5` 2026-07-01 — feat(server): /__piflow/run-digest/<run> — the run-level observation projection
- `3b46ea1` 2026-07-01 — feat(observe): buildRunView sources the token/cost/context spine from rec.usage
- `3736d90` 2026-07-01 — fix(server): surface migrate spawn/exit failures via GET /api/migrate/status
- `7e4fb00` 2026-07-01 — feat(observe): NodeDerived — compute the per-node display zones once in the surface
- `5bd120e` 2026-07-01 — refactor(observe): extract nodeTokenSpine + assembleNode + non-destructive accumulator snapshot()
- `3881e46` 2026-07-01 — feat(observe): resolveStructure — readRunModel prefers .pi/workflow.json for edge/stage parity with buildRunView
- `bd9803e` 2026-07-01 — feat(observe): widen the wire — optional per-node tokens/derived + node-enriched delta + CLI allowlist
- `9f75bb8` 2026-07-01 — feat(observe): watchRun folds telemetry incrementally + node-enriched deltas — the server-side single source
- `f8e9865` 2026-07-01 — fix(observe): the live SSE fold byte-matches /run-view (P4-live parity)
- `9f535ec` 2026-07-01 — Merge branch 'main' into feat/observe-live-sse-source
- `f1d8a81` 2026-07-02 — test(P4): failing tests + stubs for driverFits + schema agent + drivers catalog (RED)
- `0a00c73` 2026-07-02 — feat(P4): driverFits (2 axes) + schema --json agent + drivers catalog on /__piflow/agents.json (GREEN)
- `865bc2d` 2026-07-02 — test(P5): failing tests + real claude stream-json fixture (RED)
- `4c5def0` 2026-07-02 — feat(P5): driver-selected accumulator + Claude stream-json decode (count-only) + executor on the wire (GREEN)
- `80aafdb` 2026-07-02 — test(P6): failing tests + stubs for cost-spike + loopScore (RED)
- `24bf09f` 2026-07-02 — feat(P6): cost-spike (tokens-first) + loopScore (consecutive) cross-run metrics (GREEN)
- `5bd9143` 2026-07-02 — feat(server): POST /__piflow/templates — install a pushed template (no rebuild)
- `ea146ff` 2026-07-02 — Merge feat/full-run-e2e: model default = the single system fixture (pi settings.json) + template-push + cloud plane
- `9ad30e3` 2026-07-02 — fix(observe): honest telemetry for unstamped-legacy and reused nodes (E+F)
- `dcc6f14` 2026-07-02 — feat(gui+server): base-agent identity rides the catalog — agentType/agentPreset on FlowNodeData, prompt/skills/tools on agents.json rows
- `5ce7466` 2026-07-02 — fix(observe): the SSE snapshot carries the recorded node config — the loadout is never lost live
- `e070ef1` 2026-07-02 — Merge worktree-gui-frontend-fixes: GUI frontend fixes onto main so `piflowctl gui` shows them
- `e02a716` 2026-07-03 — feat(server): run-first gate bake — POST node-edit target:"run"
- `7a48983` 2026-07-03 — fix(observe): telemetryStream selects the accumulator by driver (Claude ≠ pi)
- `5946c6e` 2026-07-03 — feat(control): compose gets its own control channel — an isolated pi
- `3aea9ce` 2026-07-03 — Merge worktree-gui-frontend-fixes: run-first compose (pi session) + driver-selected telemetry
- `b04be67` 2026-07-03 — feat(server): /__piflow/skill — read + parse a SKILL.md bundle (name/desc/requires/mcp/body)
- `b9c8fac` 2026-07-03 — refactor(server): agents.json + skill display roots ride core's enumeration seam
- `bf94d4d` 2026-07-03 — feat(gui): skill marketplace panel — search, ring filter, drag a skill onto a node
- `a7a227a` 2026-07-03 — feat(server+gui): online lane in the skill marketplace — GET /__piflow/skill-search + panel ring
- `1419142` 2026-07-03 — feat(server): POST /__piflow/skill-install — one-click remote install
- `3c2330e` 2026-07-03 — feat(observe): context-composition telemetry — the per-node "element tree"
- `d6842bc` 2026-07-05 — Merge feat/context-composition-telemetry — run-layout under .piflow, per-node thinking, node --rerun, context-composition telemetry, Leg-C method-library sync
- `71076e6` 2026-07-05 — feat(observe): per-turn reasoning-effort dissection — the raw signal
- `cfbf4eb` 2026-07-05 — feat(observe,cli): mega-think anomaly + the per-turn timeline table
- `dfb781c` 2026-07-05 — fix(core/observe): add per-tool error tally to the stream reducer
- `dc3b878` 2026-07-05 — fix(core/observe): thread toolErrorCounts into RankedTool.errors
- `5001a58` 2026-07-05 — fix(core/observe): flow toolErrorCounts through runView/watch + the claude reducer
- `e6ff1f2` 2026-07-05 — fix(core/observe): expose topToolErrors on the agent-facing NodeDigest
- `f8854d8` 2026-07-05 — fix(tui): mark a rejected-only tool in the per-node tool tally
- `4a19f22` 2026-07-06 — feat(observe): M8 — substrate exposure (lineage on the index, issues endpoint + side card)
- `fdc76dd` 2026-07-06 — merge main — pick up tools.defs schema + 40 upstream commits (worktree base predated the tool-wiring overhaul)
- `dfa3583` 2026-07-06 — feat(server): issues route serves the run-level aggregate when ?node is omitted

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[agent-identity-surface]]
- [[agentic-design-library]]
- [[always-no-ff-merge-to-main]]
- [[analysis-questions-inline-not-fanout]]
- [[blueprints-layer]]
- [[capability-catalog-feed]]
- [[claude-code-executor]]
- [[cloud-control-plane-local-cloud-switch]]
- [[cloud-sandbox-portability]]
- [[codebase-memory-mcp-analysis]]
- [[codegraph-best-practices]]
- [[competitive-gaps-pdw]]
- [[config-is-truth-gui-is-projection]]
- [[context-composition-telemetry]]
- [[daytona-cloud-path]]
- [[delegate-inspection-to-subagents]]
- [[design-at-init-architecture]]
- [[eval-bulk-agents-use-cheaper-model]]
- [[expert-representations]]
- [[fixer-two-half-law]]
- [[g11-g13-node-action-protocol]]
- [[g6-agenttype-presets]]
- [[game-omni-reference-product]]
- [[gui-live-viewer-scope]]
- [[gui-nodehud-redesign]]
- [[guidance-node-sonnet5-routing]]
- [[harden-node-completes-run-to-completion]]
- [[local-docker-sandbox-mode]]
- [[loop-prevention-laws]]
- [[mastra-competitive-analysis]]
- [[memory-legs-coordination]]
- [[merge-workspace-token-bug]]
- [[minimax-m3-framing]]
- [[model-provider-single-default-fixture]]
- [[no-demo-html-wire-into-screen]]
- [[node-illustration-pipeline]]
- [[observe-single-data-path]]
- [[omniscience-piflow-setup]]
- [[optimize-loop-native-not-adhoc]]
- [[optimize-substrate-program]]
- [[overthinking-is-the-defect-not-token-caps]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-context-cloud-run-footgun]]
- [[piflow-init-scaffolder]]
- [[piflow-issue-interface]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-handbook]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[piflow-product-positioning]]
- [[piflow-rollout-enablement]]
- [[playbook-skills-depth-over-budget]]
- [[railway-deploy-from-main-not-worktree]]
- [[roadmap-bookkeeping-linear]]
- [[runs-live-in-product-runs-folder]]
- [[sandbox-readscope-default-on]]
- [[sdk-data-boundaries]]
- [[skill-marketplace-gui-design]]
- [[telemetry-first-node-diagnosis]]
- [[telemetry-legibility-tracks]]
- [[tui-dag-structure-source]]
- [[two-front-reporting]]
- [[use-understanding-system-first]]
- [[verify-nodes-never-in-dev-arms]]

### Code anchors / blast radius (codegraph)

- `deriveNode` (packages/core/src/observe/derive.ts:84) — 5 callers in `packages/core/src/observe/runView.ts`, `packages/core/src/observe/index.ts`; tests: `packages/core/test/derive.test.ts`
- `assembleNode` (packages/core/src/observe/runView.ts:374) — 4 callers in `packages/core/src/observe/runView.ts`, `packages/core/src/observe/watch.ts`; tests: `packages/core/test/claude-accumulator.test.ts`
- `NodeTokenSpine` (packages/core/src/observe/runView.ts:294) — 1 caller in `packages/core/src/observe/runView.ts`; ⚠ no covering tests found
- `nodeTokenSpine` (packages/core/src/observe/runView.ts:313) — 2 callers in `packages/core/src/observe/runView.ts`; tests: `packages/core/test/claude-accumulator.test.ts`
- `RunView` (packages/core/src/observe/runView.ts:135) — 9 callers in `packages/core/src/index.ts`, `packages/core/src/observe/index.ts`, `packages/core/src/observe/telemetry.ts`, `packages/core/src/observe/runView.ts`; tests: `packages/core/test/telemetry.test.ts`

<sub>derived 2026-07-07 · arc=87 commits · files=13 · lessons=64</sub>
<!-- okf:auto-end -->

---
type: subsystem
key: capability-catalog
title: Capability catalog (federate → introspect → bind → skills lane)
description: How external capabilities reach a node — the MCP registry is mirrored into a cached ~/.piflow/catalog slice (sync), a server's tools/list is introspected into per-tool rows (introspect), the run path slices the rows a spec selects and binds them into the registry + mcpConfig (client → assembleRunTools), and a node's skill dir is staged into .pi/skills via pi --skill.
resource: packages/core/src/catalog/client.ts
aliases: [catalog, capability, mcp, tool-bridge, skill, registry, federate, ingest, openclaw, mcpToolsToEntries, catalogForSpec, assembleRunTools, listServerTools, callTool]
seeds: [packages/core/src/catalog/sync.ts, packages/core/src/catalog/introspect.ts, packages/core/src/catalog/client.ts, packages/core/src/tools/ingest.ts, packages/core/src/tools/registry.ts, packages/core/src/runner/tool-config.ts, packages/core/src/runner/entry.ts, packages/core/src/workflow/ops/skill.ts, packages/tool-bridge/src/index.ts]
symbols: [syncMcpCatalog, introspectMcpServer, catalogForSpec, loadMcpCatalog, mcpToolsToEntries, assembleRunTools, seededRegistry, DefaultToolRegistry, resolveRunTools, listServerTools, callTool, resolveSkillStage]
tags: [catalog, capability, mcp, tools, skills, federate, core, tool-bridge, lifecycle]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
The catalog FEDERATES capabilities online and keeps the SDK product-agnostic: data lives in
`~/.piflow/catalog/`, never in `packages/`. `syncMcpCatalog` mirrors the MCP Official Registry's server
DIRECTORY (incremental cursor + tombstones) into `mcp.index.json` — deriving each `server.json` into a bridge
run-config (`servers`) + provenance (`directory`), but writing NO per-tool schemas. `introspectMcpServer`
then fetches ONE server's `tools/list` (via `listServerTools` in `@piflow/tool-bridge`) and UPSERTS its
per-tool rows via the SHARED pure `mcpToolsToEntries` — so write-side and run-side rows can't drift. At run
time `resolveRunTools` (entry.ts) calls `catalogForSpec`, which loads the slice and keeps ONLY the rows whose
`mcp.*` address the spec's nodes select (allow − deny) plus the server configs those rows reference. Those
rows ride into `assembleRunTools` as `extraEntries` → `seededRegistry` (builtins + `oc.calc:add` seed +
community), resolving a selection to pi `--tools` and a generated `-e` extension whose `callTool` reaches the
server. The SKILLS lane is parallel: `resolveSkillStage` turns `node.skill` into a host dir staged into
`.pi/skills/<name>/` (the seed seam) and emitted as `pi --skill`.

# Anchors
FEED
- `packages/core/src/catalog/sync.ts:151` — `syncMcpCatalog()` — mirror the MCP Registry server directory into the cached slice (cursor + tombstones)
- `packages/core/src/tools/catalog.ts:46` — `loadCatalog()` — the in-code seed + curated OpenClaw community tier
REGISTER
- `packages/core/src/tools/ingest.ts:38` — `mcpToolsToEntries()` — PURE listing→`ToolEntry[]` transform shared by write+run side
- `packages/core/src/tools/registry.ts:32` — `DefaultToolRegistry` — addresses tools by `namespace:name`, resolves a selection to pi `--tools` + `-e`
INTROSPECT
- `packages/core/src/catalog/introspect.ts:100` — `introspectMcpServer()` — fetch one server's `tools/list`, UPSERT its per-tool rows
- `packages/tool-bridge/src/index.ts:105` — `listServerTools()` — the real MCP `tools/list` client (the introspect default seam)
BIND
- `packages/core/src/catalog/client.ts:110` — `catalogForSpec()` — slice the cached rows + server configs a spec's `mcp.*` selects
- `packages/core/src/runner/entry.ts:38` — `resolveRunTools()` — caller-wins seam: feed the slice into the run's registry + mcpConfig
- `packages/core/src/runner/tool-config.ts:60` — `assembleRunTools()` — seed catalog+rows into the registry, union node `mcp.servers`
- `packages/tool-bridge/src/index.ts:62` — `callTool()` — the generated `-e` call site that executes a bound `mcp.*`/`oc.*` tool
SKILLS
- `packages/core/src/workflow/ops/skill.ts:40` — `resolveSkillStage()` — `node.skill` → host source + staged `.pi/skills/<name>` dir (seed seam)
- `packages/core/src/runner/command.ts:92` — emits `pi --skill <dir>` (additive even under `--no-skills`)

# Freshness (anti-drift)
anchors ✓ (every line opened + confirmed) · scope = the seeds above · re-derive when they change · DRIFT NOTE: there is NO run-time CLI `--skill` flag — the prompt's `--skill` is (a) the runner's emitted `pi --skill` (command.ts:92) and (b) a `scaffold.ts` authoring flag that binds `node.json` `prompt.skill`, NOT a `piflowctl run` flag. Also the node SCHEMA describes `skill` as "inlined into the realized prompt" (node.schema.ts:52) but the loader+runner actually STAGE it as a `.pi/skills/` dir — a stale schema description. LIVE vs STUBBED: `sync`/`introspect`/`client`/`assembleRunTools`/bridge `callTool`+`listServerTools` are real and wired into the canonical run path; the persisted catalog is a SEED + curated community tier (the `~/.piflow/catalog/` slice is populated only after a real `sync`+`introspect` run), and the OpenClaw community rows are SKELETON (names-only, descriptions/params filled later by the capture-shim).

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/catalog/sync.ts` | ✓ |
| `packages/core/src/catalog/introspect.ts` | ✓ |
| `packages/core/src/catalog/client.ts` | ✓ |
| `packages/core/src/tools/ingest.ts` | ✓ |
| `packages/core/src/tools/registry.ts` | ✓ |
| `packages/core/src/runner/tool-config.ts` | ✓ |
| `packages/core/src/runner/entry.ts` | ✓ |
| `packages/core/src/workflow/ops/skill.ts` | ✓ |
| `packages/tool-bridge/src/index.ts` | ✓ |

### Evolution arc

- `e570755` 2026-06-21 — feat(core): DAG compiler + contract codec + registry + sandbox + hooks
- `603dd7c` 2026-06-21 — feat(core): MCP tools/list → ToolEntry ingestion (the effortless catalog fill)
- `a4751de` 2026-06-21 — feat(core): wire outside tools end-to-end — resolve generates the -e, runner stages it + bind-gates each node
- `261d282` 2026-06-21 — feat(tool-bridge): @piflow/tool-bridge — the MCP transport runtime the generated -e imports
- `b3bf68d` 2026-06-21 — feat(core): bundle generated -e + OpenClaw sdk lane + per-node MCP config staging
- `6d99eca` 2026-06-22 — feat(tool-bridge): route oc.<plugin>:<tool> to the OpenClaw MCP gateway
- `1cf048f` 2026-06-23 — feat(core): registry resolves bare pi builtins + excludeTools from deny (U3)
- `62cbc0c` 2026-06-23 — feat(core): runFromConfig + loadConfig (U8)
- `136635a` 2026-06-23 — fix(tools): register submit_result builtin so migrated nodes bind
- `bf9073b` 2026-06-23 — fix(tools): register submit_result as a real first-party contract tool
- `a6f974a` 2026-06-23 — feat(core): runFromTemplate joins loadTemplate+instantiate+run; --arg channel (S5)
- `9d54218` 2026-06-24 — feat(core): generic run-profile node elision + transitive dep rewire
- `6aae3e6` 2026-06-25 — feat: wire expandFusion into the run path + dry-run; runnable example (T2.4/T2.6)
- `2b1f8d1` 2026-06-25 — feat(core): G9 — subworkflow sub-DAG inlining (expandSubworkflow)
- `1478bf3` 2026-06-25 — test(core): M1 tool-config red bar — assembleRunTools must seed oc.* + union mcp
- `32c3b42` 2026-06-25 — feat(core): assembleRunTools — seed the tool catalog into the canonical run path (M1)
- `a3fdf7a` 2026-06-25 — feat(core): expandReroute — unroll the bounded QA loop into a forward-only acyclic DAG with a zero-pi #17 short-circuit (M3, closes #2/#5/#17)
- `0564114` 2026-06-26 — merge: integrate main (G3/G6/G7/G9) into the node-action M0–M7 lineage
- `169cb6d` 2026-06-26 — feat(observe): lift the fleet registry + discovery into @piflow/core
- `e78f94c` 2026-06-26 — refactor(cli): rename global bin piflow → piflowctl
- `d074a39` 2026-06-26 — feat(catalog): feed the ~/.piflow catalog slice into the run path so mcp.* nodes bind
- `369d7d3` 2026-06-26 — feat(catalog): sync() — federate the MCP Official Registry server directory into ~/.piflow
- `408823a` 2026-06-26 — feat(catalog): introspectMcpServer — capture a server's tools/list into per-tool entries (binding closes)
- `7abfa3c` 2026-06-26 — fix(catalog): sync derives transport:'stdio' for stdio packages (was failing the bridge config union)
- `74f6b08` 2026-06-26 — feat(catalog): real tools/list client in the bridge, wired as introspectMcpServer's default (loop is live)
- `b5972f2` 2026-06-26 — feat(skills): wire node.skill — stage the skill folder into the sandbox + emit --skill (reuse the seed seam)
- `7126ce1` 2026-06-28 — feat(core): skill requires/allowed manifest + resolver + preflight (SA-A)

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[blueprints-layer]]
- [[capability-catalog-feed]]
- [[claude-code-executor]]
- [[cloud-sandbox-portability]]
- [[codebase-memory-mcp-analysis]]
- [[codegraph-best-practices]]
- [[competitive-gaps-pdw]]
- [[daytona-cloud-path]]
- [[expert-representations]]
- [[g11-g13-node-action-protocol]]
- [[g6-agenttype-presets]]
- [[game-omni-reference-product]]
- [[gui-live-viewer-scope]]
- [[gui-nodehud-redesign]]
- [[mastra-competitive-analysis]]
- [[node-illustration-pipeline]]
- [[optimize-loop-native-not-adhoc]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-init-scaffolder]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[piflow-product-positioning]]
- [[piflow-rollout-enablement]]
- [[piflowctl-bin-rename]]
- [[site-piflow-no-unrequested-chrome]]
- [[swarm-consensus-deferred]]

### Code anchors / blast radius (codegraph)

- `resolveRunTools` (packages/core/src/runner/entry.ts:38) — 3 callers in `packages/core/src/runner/entry.ts`; tests: `packages/core/test/catalog-client.test.ts`
- `listServerTools` (packages/tool-bridge/src/index.ts:105) — 2 callers in `packages/core/src/catalog/introspect.ts`; tests: `packages/tool-bridge/test/list-server-tools.test.ts`
- `seededRegistry` (packages/core/src/tools/catalog.ts:58) — 8 callers in `packages/cli/src/inspect.ts`, `packages/cli/src/run.ts`, `packages/core/src/runner/tool-config.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/catalog.test.ts`
- `mcpToolsToEntries` (packages/core/src/tools/ingest.ts:38) — 9 callers in `packages/core/src/catalog/introspect.ts`, `packages/core/src/runner/tool-config.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/runner.test.ts`, `packages/core/test/tools-ingest.test.ts`, `packages/core/test/tools-verify.test.ts`
- `assembleRunTools` (packages/core/src/runner/tool-config.ts:60) — 5 callers in `packages/core/src/runner/entry.ts`; tests: `packages/core/test/catalog-client.test.ts`, `packages/core/test/catalog-introspect.test.ts`, `packages/core/test/tool-config.test.ts`

<sub>derived 2026-07-01 · arc=27 commits · files=9 · lessons=27</sub>
<!-- okf:auto-end -->

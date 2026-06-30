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

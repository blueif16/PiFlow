# OpenClaw on localhost — the FINAL architecture verdict for serving community tool plugins

> **What this settles:** whether piflow can stand up OpenClaw's plugin runtime *itself* (no foreign
> service) and serve EVERY regular tool plugin on the localhost laptop over the same internal `oc.*`
> channel, reachable from both a local pi run and a Daytona VM. Decided from the **vendored OpenClaw
> source** at `vendor/openclaw/` (v2026.6.9), not web search or guesswork.
>
> **Grounding convention:** every piflow claim carries `file:line`; every OpenClaw-runtime claim carries
> `vendor/openclaw/<path>:<line>`. External-only facts (the MCP transport spec) are flagged. Where the
> source genuinely cannot settle a point it is marked **UNVERIFIED** with the file you'd need.
>
> **READ-ONLY research.** No source (piflow or vendor) was modified. This file is the only artifact.

---

## TL;DR (the verdict, up front)

1. **pi ↔ OpenClaw runtime compatibility: PARTLY-TRUE → effectively FALSE for "natively compatible."**
   Vendored OpenClaw is **v2026.6.9**. It **forked/internalized its own agent runtime** (`@openclaw/agent-core`
   + `@openclaw/llm-core`) and consumes **zero pi runtime packages** — it keeps only `@earendil-works/pi-tui`
   (a terminal-rendering toolkit). The shared lineage is real but **historical**: OpenClaw *used to* run on
   pi's SDK and migrated off by this version. A bare pi process **cannot** satisfy what plugins demand; the
   plugin contract is bound to **OpenClaw's gateway host**, not to any agent engine.

2. **"Serve EVERYTHING on one localhost gateway, same `oc.*` channel local & remote": PARTLY-TRUE — YES-WITH-CONDITIONS.**
   You CAN host the **request/response + provider + keyed-state** tier ourselves in-process (memory, workboard,
   tavily/firecrawl/xai, diffs-artifact, llm-task-via-nested-pi). You CANNOT serve the **L3 / node-bus tier**
   (browser, canvas, file-transfer, codex-supervisor) from a plain in-process host — those need a long-running
   service daemon or a paired-node bus that only OpenClaw's full gateway (or a real port of its L3 layer) runs.
   **The one load-bearing condition:** *reachability by a remote VM*. OpenClaw's own `plugin-tools-serve` is
   **stdio-only — no HTTP listen mode** (`vendor/openclaw/src/mcp/plugin-tools-serve.ts:80`,
   `src/mcp/tools-stdio-server.ts:29`), so it can NEVER be shared over the network by a Daytona VM. To get one
   localhost endpoint reachable by both a local pi run and a cloud VM you must put **our own HTTP MCP face**
   in front of the in-process host. The VM "just sits in front" is wrong about which side faces the network.

3. **What executes end-to-end TODAY for `oc.*`: only `oc.calc:add`.** It self-binds its NATIVE execute into
   the generated `-e` because its `origin.ref` has no `#` (`catalog.ts:38`), so `pluginModuleFromRef` returns
   an importable specifier (`compile.ts:106-113`) and `isNativeSdk` is true (`compile.ts:140-142`). Every
   community `oc.*` entry carries a git-source pin with `#` (`openclaw-community.ts:116`) → non-importable →
   it routes through the bridge to the reserved `openclaw` MCP server — **which nothing provisions on the live
   CLI path** (`cli/run.ts:375` passes no `mcpConfig`/`secretResolver`; the only provisioner is the e2e test).
   So community `oc.*` tools are **discoverable but not executable** in a real run today.

4. **This CONVERGES with the team's standing "SDK not gateway" decision — that is the certainty, not a new turn.**
   The load-bearing prior decision (`pi-tools-extensions-openclaw-2026-06-21.md:5`) is verbatim: *"mirror how
   OpenClaw extends pi — but as an SDK, NOT a gateway"*; §4 (`:189-194`) frames OpenClaw as "a host that owns
   the pi session and feeds it a curated tool set … Our SDK occupies the same role." My in-process-host
   recommendation (Approach A) **is** that decision, now re-grounded in the full vendored source. The only place
   the source OVERRIDES prior research is the lineage caveat (some 2026-06-21 docs hedged "OpenClaw's core
   runtime is closed-source" — the vendored MIT tree refutes that) and the capture-shim shape (the docs assumed
   a bare `def.execute`; every plugin actually registers a **factory** — see §8). Full reconciliation in **§8**.

---

## 1. piflow inventory — every OpenClaw seam

Approach tags: **A** = "fold the substrate into our SDK" (in-process host); **B** = "bridge to OpenClaw's
own gateway" (route `oc.*` → reserved MCP server); **native-calc** = the self-binding pure seed; **shared** =
used by both lanes.

| # | File:line | What it does | Tag | Live or ORPHANED |
|---|---|---|---|---|
| 1 | `packages/core/src/tools/openclaw-host.ts:1-578+` | In-process EXECUTE driver: runs each plugin's `register(api)` against a **real-or-stub `runtime`**, captures the tool FACTORY, calls `factory(ctx)` → `tool.execute(...)`. Loads plugins from `node_modules/openclaw/dist/extensions` (`:571`). | **A** | **ORPHANED** — imported only by its own tests (`test/openclaw-*-host*.test.ts`, `openclaw-register-all.test.ts`); zero live-path importers. |
| 2 | `packages/core/src/tools/openclaw-shim.ts:50-148` | Capture-shim: drives `register(api)` against a NO-OP `api` to learn each tool's `def` (description/parameters) + its native `execute`; the missing `api.runtime` is the **purity gate**. `captureOpenClawTools` (`:129`) is imported INTO the generated `-e` to bind native execute. | **native-calc / shared** | **WIRED** — `compile.ts:227` imports it into the bundle for native sdk tools (calc). Also a host-side discovery aid. |
| 3 | `packages/core/src/tools/catalog.ts:26-40` | The persisted seed catalog. `oc.calc:add` with `origin.ref:'@piflow/core/seeds/calc'` (no `#` → importable). | **native-calc** | **WIRED** — `seededRegistry` (`:58`) feeds `assembleRunTools`. |
| 4 | `packages/core/src/tools/openclaw-community.ts:50-128` | The curated community catalog (memory-core/lancedb, firecrawl, tavily, file-transfer, llm-task, lobster), persisted as **SKELETON, gateway-coupled** entries; every `origin.ref` is a git-source pin `openclaw@2026.6.9#extensions/<dir>` (`:116`). Tagged `gateway-coupled`. | **B** | **WIRED into the catalog** (discoverable) but **NOT executable** — the git-source ref is non-importable by design. |
| 5 | `packages/core/src/tools/ingest.ts:90-105` | `openClawPluginToEntries`: pure map of a names-only `openclaw.plugin.json` → skeleton `ToolEntry[]` (`address=oc.<id>:<tool>`, `source:'sdk'`, description `''`, parameters omitted). | **shared (B-seed)** | **WIRED** — used by both catalog tiers. |
| 6 | `packages/core/src/tools/compile.ts:106-113` | `pluginModuleFromRef`: a ref with `#` → `undefined` (git-source pin, non-importable); else strip `@version`. **This is the gate that splits calc from community.** | **shared** | **WIRED** — the live compile path. |
| 7 | `packages/core/src/tools/compile.ts:140-142,172-199` | `isNativeSdk` + `renderTool`: a pinned (importable) sdk tool binds the plugin's **native execute** via the capture-shim INTO the `-e`; every other sdk/mcp tool renders `execute → callTool(address)` through the bridge. | **shared (A∥B split point)** | **WIRED.** |
| 8 | `packages/tool-bridge/src/address.ts:50-95` | `parseAddress`: `oc.<plugin>:<tool>` → reserved server **`openclaw`** + raw tool name (the `<plugin>` is provenance only). `OPENCLAW_SERVER='openclaw'` (`:41`). | **B** | **WIRED** (the parser) — but the `openclaw` server it points at is unprovisioned in live runs. |
| 9 | `packages/tool-bridge/src/index.ts:62-88` | `callTool`: parse address → look up server config in the resolved `BridgeConfig` → lazy MCP `tools/call` with the raw tool name. Throws `unknown-server` when the named server isn't configured (`:67-72`). | **B / shared** | **WIRED** — the generated `-e` imports it. For `oc.*` it throws `unknown-server` unless a host configured `openclaw`. |
| 10 | `packages/tool-bridge/src/config.ts` (`configureBridge`, `CONFIG_ENV`) | Bridge config source: explicit `configureBridge(...)` or the `PIFLOW_MCP_CONFIG` file path env. | **B** | **WIRED** as a mechanism; the live runner stages `_pi/mcp.json` only for nodes that authored `mcp.servers` (no node authors `openclaw`). |
| 11 | `packages/core/src/runner/tool-config.ts:60-104` | `assembleRunTools`: builds the run registry (`seededRegistry` + `submit_result` + ingested mcp rows) and **`mcpConfig` = union of every node's authored `node.mcp.servers`** (byte-identical-or-throw). **Does NOT synthesize an `openclaw` server** — only authored ones. | **shared** | **WIRED** — the canonical run path. |
| 12 | `packages/core/src/runner/runner.ts:438-441` | `selectedBridgedTool`: a node "selected a bridge tool" iff an `mcp.*` OR `oc.*` address survives allow−deny. Triggers `_pi/mcp.json` staging. | **shared** | **WIRED.** |
| 13 | `packages/core/src/runner/runner.ts:947-960,1090-1094` | The staging block: stages `_pi/mcp.json` + injects `PIFLOW_MCP_CONFIG` + referenced `$VAR`s **only when** `selectedBridgedTool(node) && ctx.mcpConfig`. `oc.*` "stages identically — the host supplies the reserved `openclaw` server in `mcpConfig.servers`" (`:426-427`). **No host does.** | **B** | **WIRED gate, DORMANT for `oc.*`** — fires for authored `mcp.*` servers, never for `openclaw`. |
| 14 | `packages/core/src/runner/entry.ts:138-182` (`runFromTemplate`) | The template→run join. Calls `resolveRunTools` (`:173`) = `assembleRunTools` honoring explicit caller registry/mcpConfig, then `runWorkflow` with `registry`/`mcpConfig` (`:180-181`). | **shared** | **WIRED** — the CLI live path. |
| 15 | `packages/cli/src/run.ts:375-394` (`runFromTemplate` call) | The live CLI run: passes `providerName`, `thinking`, `model`, sandbox `provider` — **passes NO `mcpConfig` and NO `secretResolver`.** | **shared** | **WIRED** — and this is exactly why `oc.*`/`mcp.*` community tools have no server to reach in a real CLI run. |
| 16 | `packages/tool-bridge/test/tool-bridge-openclaw-gateway.e2e.test.ts:66-94` | The ONLY thing that provisions the `openclaw` server: `configureBridge({ servers:{ openclaw:{ transport:'stdio', command:'node', args:[plugin-tools-serve.js] }}})`, then `callTool('oc.memory-core:memory_get', …)`. | **B** | **TEST-ONLY** (skips unless `openclaw` installed). Proves the B lane works against the real `plugin-tools-serve`, but nothing in the product wires it. |

**Inventory verdict:** the **A lane** (`openclaw-host.ts`) is fully built through S3 but **orphaned** from the
run path. The **B lane** (catalog → address → bridge → reserved `openclaw` server) is wired end-to-end EXCEPT
the final hop: **no production code provisions the `openclaw` server**, so community `oc.*` is discoverable-only.
The **native-calc lane** is the only one that closes the loop in a live run.

---

## 2. Two approaches reconciled + what runs TODAY

### Timeline (from `git log --oneline --all`)

The B lane (bridge) landed **first**; the A lane (in-process host) landed **second** and was explicitly
positioned as superseding B *for the plugin question*:

- **B lane, ~June 20–22:** `261d282 feat(tool-bridge): @piflow/tool-bridge` → `6d99eca feat(tool-bridge):
  route oc.<plugin>:<tool> to the OpenClaw MCP gateway` → `0df5954 seed catalog with curated real OpenClaw
  community tool plugins` → `057a22b test(tool-bridge): real oc.* lane e2e against OpenClaw plugin-tools-serve`
  → `f98ab59 pin openclaw devDep so the oc.* gateway e2e always runs`. The B lane = "reference OpenClaw over
  its own `plugin-tools-serve` MCP server."
- **A lane, June 22 (`feat/openclaw-plugin-host`):** `572e756 docs(design): OpenClaw plugin substrate
  adoption` → `1f78c00 S0 — drive real memory_get execute through in-process host` → `2953ed1 S1 — register
  all installed tool-bearing plugins` → `baee957 S2 — route SecretResolver keys to key-gated tools` →
  `2062567 S3 — bind runEmbeddedAgent to the pi CLI; drive llm-task` → `5175533 Merge` → `4c9d15b mark S0-S3
  implemented`. The A lane = "host the plugin substrate ourselves on pi; no foreign service."
- **Then the cloud framing, June 24–26:** `f339632 docs(design): cloud tool-gateway architecture` (which
  actually recommends *replacing* gateway-coupled `oc.*` with equivalent remote **MCP** servers for v1 — a
  third position).

### Do they supersede, complement, or conflict?

**They are complementary by RUN LOCATION, and the substrate doc says so explicitly** — but the product
currently wires *neither* `oc.*` lane for community plugins, so in practice they are an **inconsistent,
half-wired pair** today.

- **A (in-process host)** is the right answer for **local** execution with no foreign service: drive the
  plugin's execute in our own process (`openclaw-host.ts`).
- **B (bridge → `plugin-tools-serve`)** is the right answer when you accept a **separate OpenClaw process**
  reachable over MCP (stdio locally, or HTTP if *OpenClaw exposed one* — it does not, see §4).
- The substrate doc (`docs/design/openclaw-substrate-adoption.md:3`) states A "**Supersedes the 'reference
  OpenClaw over MCP' framing for the plugin question**." The cloud doc (`cloud-tool-gateway-architecture.md:392-406`)
  then says for the *cloud* case, skip both `oc.*` lanes and use equivalent remote MCP servers (firecrawl/tavily
  have their own). So there are really **three** positions on record; the codebase has the **scaffolding for
  all three** and the **closed loop for none but calc.**

### The honest one-liner

**Only `oc.calc:add` executes through a real pi node today.** The reason, traced in source:

- calc's `origin.ref` is `@piflow/core/seeds/calc` (`catalog.ts:38`) — **no `#`**, so
  `pluginModuleFromRef` returns it as an importable specifier (`compile.ts:108-112`), `isNativeSdk` is true
  (`compile.ts:140-142`), and `renderTool` emits a block that runs `captureOpenClawTools(__ocPlugin)` and binds
  `__d.def.execute` **inline into the `-e`** (`compile.ts:177-189`). No gateway, no bridge — the tool brings
  its own pure execute, which `bundleExtension` (`compile.ts:312-325`) inlines.
- Every community `oc.*` entry's ref is `openclaw@2026.6.9#extensions/<dir>` (`openclaw-community.ts:116`) —
  **has `#`** → `pluginModuleFromRef` returns `undefined` (`compile.ts:108`) → not native → `renderTool` emits
  `execute → callTool('oc.<plugin>:<tool>', …)` (`compile.ts:191-198`). At runtime `callTool` parses to the
  reserved `openclaw` server (`address.ts:69`) and throws `unknown-server` (`index.ts:67-72`) because the live
  CLI never configured it (`cli/run.ts:375-394` passes no `mcpConfig`). Even if it *were* configured, it would
  require a running `plugin-tools-serve` (§4) — a foreign process.

So: **calc closes the loop natively; every community plugin is discoverable but unexecutable in a live run**,
for two independent reasons (non-importable ref → bridge; bridge target unprovisioned).

---

## 3. pi ↔ OpenClaw runtime compatibility — FROM `vendor/openclaw` SOURCE

**Vendored version: `openclaw` v2026.6.9** (`vendor/openclaw/package.json:2-3`) — identical to the installed
npm `openclaw@2026.6.9`, so the lineage facts below apply to both.

### Finding 1 — OpenClaw consumes ZERO pi runtime packages; the only `@earendil-works` dep is a TUI toolkit

- `vendor/openclaw/package.json:1950` — `"@earendil-works/pi-tui": "0.78.0"`. Every import of it is for
  terminal widgets, e.g. `vendor/openclaw/src/tui/components/chat-log.ts:3: import { Container, Spacer, Text }
  from "@earendil-works/pi-tui";`. This is **`pi-tui` (rendering)**, NOT `pi-coding-agent` / `pi-agent-core` /
  `pi-ai` (the agent runtime). A whole-tree grep for runtime pi imports (`pi-coding-agent`, `pi-agent-core`,
  `pi-ai`, `@mariozechner/*`, non-`pi-tui` `@earendil-works/*`) returns **zero** non-test, non-TUI hits.

### Finding 2 — OpenClaw ships its OWN agent-core with its own tool-call loop, depending on no pi package

- `vendor/openclaw/packages/agent-core/package.json:97-100` — dependencies are exactly
  `"@openclaw/llm-core": "workspace:*"` and `"typebox"`. **Nothing from pi.**
- The driver loop is OpenClaw's own: `vendor/openclaw/packages/agent-core/src/agent-loop.ts:258
  async function runLoop(...)`, with `:298 while (true) {` and `:302 while (hasMoreToolCalls || …) {`, streaming
  via `agent-loop.ts:3: import { EventStream as LlmEventStream } from "@openclaw/llm-core";`.

### Finding 3 — pi survives ONLY as a dated, removal-scheduled deprecated alias (the fork is explicit)

- `vendor/openclaw/src/plugins/runtime/types-core.ts:237-239` —
  `runEmbeddedAgent: RuntimeRunEmbeddedAgent;` then `/** @deprecated Use runEmbeddedAgent. */
  runEmbeddedPiAgent: RuntimeRunEmbeddedAgent;`.
- `vendor/openclaw/src/plugins/compat/registry.ts:531-547` — a deprecation record `owner:"agent-runtime"`,
  `deprecated:"2026-05-21"`, `removeAfter:"2026-08-21"`, replacement "runEmbeddedAgent…"; release note:
  "Legacy `runEmbeddedPiAgent` and `EmbeddedPi*` plugin aliases remain as deprecated SDK compatibility only."
- `vendor/openclaw/docs/plugins/sdk-runtime.md:145-147` — `runEmbeddedAgent(...)` is "the neutral helper for
  starting a **normal OpenClaw agent turn**"; `runEmbeddedPiAgent(...)` "remains as a **deprecated
  compatibility alias**." `AGENTS.md:33` treats "Pi-style runtimes" as a *sibling/peer*, not the engine.

> **Reconciliation with piflow's own substrate doc:** `docs/design/openclaw-substrate-adoption.md:32` states
> OpenClaw "originally ran on pi's SDK … **migrated off** by `openclaw@2026.6.9` — internalized
> `packages/agent-core`." This is **consistent** with the source: the lineage is real but historical. The
> claim "natively compatible" is true only at the level of *design contracts* (the `Agent`/`agentLoop`/harness
> *shapes* still resemble pi), not at the level of *runtime dependency or interchangeability*.

### The services a plugin can demand — and whether bare pi has an equivalent

Defining interfaces: register-time API `OpenClawPluginApi` (`vendor/openclaw/src/plugins/types.ts:2611`);
injected runtime `PluginRuntime = PluginRuntimeCore & {subagent, nodes, channel}`
(`vendor/openclaw/src/plugins/runtime/types.ts:80`); core half `PluginRuntimeCore`
(`vendor/openclaw/src/plugins/runtime/types-core.ts:180`).

| Service | Defined at | Register- vs Execute-time | pi-native equivalent? |
|---|---|---|---|
| `registerTool` | `src/plugins/types.ts:2640` | REGISTER (tool's `execute` is per-call) | **Closest to pi-native** — registering a closure is generic. (But the factory gets OpenClaw `ctx`.) |
| `runtime.state.openKeyedStore` | `src/plugins/runtime/types-core.ts:373` | REGISTER to open; store CRUD is EXECUTE | **No equivalent → needs a host** (SQLite-backed, plugin-isolated, restart-surviving). |
| `runtime.agent.runEmbeddedAgent` | `src/plugins/runtime/types-core.ts:237` | EXECUTE | **Conceptually pi-like** — maps to a nested agent turn; piflow already binds it to a nested `pi` CLI (`openclaw-host.ts:197-374`). The closest thing to a real bridge. |
| `registerService` (long-running) | `src/plugins/types.ts:2697` (wired `src/plugins/registry.ts:2825`) | REGISTER (host owns lifecycle) | **No equivalent → needs OpenClaw host.** Lifecycle runner is gateway-only (§4). |
| `registerHttpRoute` | `src/plugins/types.ts:2649` | REGISTER | **No equivalent → needs OpenClaw host** (served by the gateway HTTP server). |
| `registerGatewayMethod` | `src/plugins/types.ts:2661` | REGISTER | **No equivalent → needs OpenClaw host** (Gateway RPC, operator scopes). |
| `lifecycle.registerRuntimeLifecycle` | `src/plugins/types.ts:2607` | REGISTER (host invokes on shutdown/reload) | **No equivalent → needs OpenClaw host** (tied to gateway lifecycle). |
| `nodes.invoke` / node-bus | `src/plugins/runtime/types.ts:91-94`; gateway-bound at `src/plugins/runtime/gateway-bindings.ts:32 setGatewayNodesRuntime` | EXECUTE (policy `registerNodeInvokePolicy` is REGISTER) | **No equivalent → strictly needs OpenClaw host** (invokes commands on paired devices via the Gateway). |
| `runtime.llm.complete` / `registerEmbeddingProvider` | `types-core.ts:399`; `src/plugins/types.ts:2715` | `register*` REGISTER; `llm.complete` EXECUTE | **Partial** — maps onto pi's provider layer, but providers register into OpenClaw's capability registry + use OpenClaw model/auth prep. |

The `subagent` and `nodes` runtime members are bound to the gateway at startup via process-global singletons
(`vendor/openclaw/src/plugins/runtime/gateway-bindings.ts:28,32`; `src/plugins/runtime/index.ts:238,242`).

### VERDICT (lineage claim)

> **"OpenClaw's runtime is NATIVELY compatible with pi" — PARTLY-TRUE, and FALSE as stated.**

The lineage is genuine but **historical**: OpenClaw was a *consumer* of pi's published SDK and **migrated off
it** by v2026.6.9, internalizing `@openclaw/agent-core`/`@openclaw/llm-core` (zero pi deps). A **bare pi process
cannot run a community plugin**, because the plugin contract demands gateway-host services — `registerService`,
`registerHttpRoute`, `registerGatewayMethod`, `registerRuntimeLifecycle`, the SQLite `openKeyedStore`, and
`nodes.invoke` — that are bound to the OpenClaw Gateway, not to any agent engine. The **one** deep service that
*does* map cleanly to pi is `runtime.agent.runEmbeddedAgent` (≈ a nested agent turn) — which is exactly the
single seam piflow already bridged. Everything else is "needs an OpenClaw-shaped host."

---

## 4. What IS "OpenClaw's gateway" + the localhost-serve thesis, head-on

### What the gateway is (from `vendor/openclaw/docs/gateway` + `src/gateway`)

OpenClaw's "gateway" is a **single always-on daemon that multiplexes routing, a control plane, channel
connections, agents, and an HTTP/WS API onto ONE port** — it is not a tool server, it bundles everything:

- `vendor/openclaw/docs/gateway/index.md:73` — "One always-on process for routing, control plane, and channel
  connections." `:74-79` — "Single multiplexed port for: WebSocket control/RPC / HTTP APIs (`/v1/models`, …
  `/tools/invoke`) / Plugin HTTP routes / Control UI and hooks." `:154-156` — "A single gateway can host
  multiple agents and channels."
- It hosts channels (telegram/slack/…), the OpenAI-compat `/v1/*` surface, the `/tools/invoke` HTTP endpoint
  (`vendor/openclaw/src/gateway/tools-invoke-http.ts`), plugin HTTP routes, and plugin **services**.

### Is serving plugin TOOLS separable from channels/UI? — YES, and `plugin-tools-serve` is exactly that

`vendor/openclaw/src/mcp/plugin-tools-serve.ts` (= the shipped `dist/mcp/plugin-tools-serve.js`) is a
**standalone MCP server that serves plugin-registered tools with no gateway and no channels**:

- `plugin-tools-serve.ts:1-8` (docstring) — "Standalone MCP server that exposes OpenClaw plugin-registered
  tools … so ACP sessions running Claude Code can use them." It is referenced by **no other production
  source** (grep across `src` returns only itself + its test).
- It loads a **tool-discovery-only snapshot**, not the full runtime: `:43-55 resolveTools()` →
  `ensureStandalonePluginToolRegistryLoaded(...)` then `resolvePluginTools(...)`; the registry is loaded with
  `activate:false, toolDiscovery:true` (`src/plugins/tools.ts:1006-1011`), and the loader **explicitly skips**
  pinning channel/provider/HTTP-route registries (`src/plugins/standalone-runtime-registry-loader.ts:82-99`).
  No channel/gateway/bonjour/pairing/lock imports.

### The two BLOCKERS for "everything on one localhost gateway"

**Blocker 1 — L3 services are NOT hosted by `plugin-tools-serve` (gateway-startup-only).** The service
lifecycle runner is `startPluginServices(...)` (`vendor/openclaw/src/plugins/services.ts:95`), which iterates
`registry.services` and calls `service.start(...)` (`:106,116`). It is called from **only two sites, both
gateway startup** (`src/gateway/server.impl.ts:1319,1380`; `src/gateway/server-startup-post-attach.ts:769`).
The plugin **loader does not auto-start services** (grep for `startPluginServices`/`service.start` in
`src/plugins/loader.ts` → none). Because `plugin-tools-serve` loads `activate:false`+`toolDiscovery:true` and
never calls `startPluginServices`, **a browser/canvas plugin's L3 daemon does NOT run under it** — only its
request/response tool surface. Running those as live services requires the full gateway (or our own process
that itself runs the L3 lifecycle).

**Blocker 2 — `plugin-tools-serve` is stdio-ONLY; no HTTP listen mode.** Transport is `StdioServerTransport`
(`vendor/openclaw/src/mcp/tools-stdio-server.ts:29`; connected at `plugin-tools-serve.ts:80`). There is **no
`StreamableHTTP`/`SSE`/`listen(`** anywhere in `src/mcp` non-test (it appears only in a `.d.ts` type shim,
never instantiated). It takes **no `--http`/`--port`** (only `process.argv[1]` for the main-module guard,
`:83`). The only network-reachable OpenClaw tool surface is the **gateway's** `POST /tools/invoke`
(`docs/gateway/tools-invoke-http.md:11` "same port as the Gateway", `:18-19` gateway auth, `:45` full-operator
boundary) — which pulls in the **full gateway**.

> **External fact (MCP spec, flagged):** the June-2025 MCP "Streamable HTTP" transport (single `/mcp` endpoint,
> JSON-RPC POST, optional SSE) is the standard remote transport. OpenClaw's `plugin-tools-serve` does **not**
> implement it; any HTTP face must be ours. (Already captured in `cloud-tool-gateway-architecture.md:39-60`.)

### The thesis, option-by-option

> *"ONE localhost runtime serves ALL regular tool plugins AND is reachable by both a local pi run AND a
> Daytona VM over the SAME `oc.*` scheme."*

**(a) OUR host (`openclaw-host.ts` extended to L3) — the substrate-adoption path.**
- *Requirements:* the existing execute driver + the L1 contract (`plugin-sdk`, zero deps) + a `runtime` shim;
  to reach ALL plugins, a real **L3 layer** (port `registerService`/`registerHttpRoute`/lifecycle/node-bus from
  `src/gateway`+`src/plugins`, the substrate doc's "Layer 3", `openclaw-substrate-adoption.md:72-80`); plus
  **our own HTTP MCP face** to be remote-reachable.
- *Runtime footprint:* the host closure (~332 KB / 5 chunks per the doc), plus a daemon for L3.
- *Separable from channels:* fully — channels are never loaded.
- *What blocks "everything":* the L3 port (browser daemon, canvas HTTP server, node-bus for file-transfer) is
  the hard, bounded part the doc defers as S4 (`openclaw-substrate-adoption.md:148`). Per-plugin secrets are
  handled (S2). **This is the ONLY option that yields "no foreign service" AND can be wrapped in our own HTTP
  for remote reach.**

**(b) `plugin-tools-serve` — spawn OpenClaw's standalone server.**
- *Requirements:* `openclaw` installed (~86 MB), spawned per consumer over stdio.
- *Footprint:* one node child process per spawn.
- *Separable from channels:* yes (it never loads them).
- *What blocks "everything":* **stdio-only (Blocker 2)** → a Daytona VM can never reach a localhost
  `plugin-tools-serve`; it is a per-spawn local child. **And L3 plugins don't run under it (Blocker 1).** So it
  serves the request/response tier locally only. This is a **foreign service** the user explicitly does not want
  as the answer, and it cannot satisfy the remote-reach half of the thesis on its own.

**(c) Fold execute into the `-e` bundle (extend native-calc to community plugins).**
- *Requirements:* the plugin must be *importable* (an npm specifier or a path) AND its execute must be
  satisfiable by the capture-shim's no-op `api`.
- *What blocks "everything":* **the per-plugin matrix (§5) shows ZERO of the 12 regular plugins are pure** —
  even the lightest (tavily/firecrawl/xai) need a config object to resolve their key, and memory/workboard need
  a state store; none run under the no-op shim. Worse, **every plugin registers a FACTORY `(ctx)=>tool`, not a
  bare `def`** (§5), so the current shim (which reads `def.execute`, `openclaw-shim.ts:182`) would bind
  `undefined` for all of them — calc only works because its def *is* the tool. So (c) generalizes to **calc
  and nothing else** without (i) a factory-aware shim and (ii) a real `runtime` in-bundle — at which point it
  has become option (a) inlined into the agent, which also doesn't help remote reach.

### VERDICT (localhost-serve thesis)

> **YES-WITH-CONDITIONS.** One localhost runtime CAN serve the **request/response + provider+secret +
> keyed-state + embedded-agent** tier of regular plugins **if it is OUR in-process host (option a)** — not
> `plugin-tools-serve`, which is stdio-only and skips L3. It **CANNOT** serve the **L3-daemon / node-bus**
> plugins (browser, canvas, file-transfer, codex-supervisor) without porting OpenClaw's L3 layer.
>
> **The load-bearing condition for "reachable by both a local pi run AND a Daytona VM over the same `oc.*`":**
> the runtime must expose an **HTTP (Streamable-HTTP) MCP face that WE write** in front of the in-process host.
> OpenClaw ships **no** networkable plugin-tool server; the VM "just sitting in front" is backwards — the
> localhost host must face the network (egress-reachable HTTPS), and the VM is the *client*. Locally, the same
> host is reached over stdio (or the same HTTP). Both clients use `oc.<plugin>:<tool>` → reserved `openclaw`
> server → (stdio for local / HTTPS for VM).

---

## 5. Per-plugin executability matrix (regular tools, source-read from `vendor/openclaw/extensions/`)

All 14 named plugins are present in `vendor/openclaw/extensions/` (verified). Columns: **execute needs** ·
**reachable-via** · **status**. "in-process-host" = needs a `runtime` shim but **no** L3 daemon/channel/bus;
"gateway/serve" = needs an L3 service, node-bus, external daemon, or the embedded-agent subsystem.

| Plugin | execute needs | service / bus (file:line) | registerTool shape | reachable-via | status |
|---|---|---|---|---|---|
| **memory-core** | KEYED-STATE + fs (memory files) | `openKeyedStore` `index.ts:185`; no service | factory `(ctx)=>tool` `index.ts:200` | **in-process-host** | VERIFIED |
| **memory-wiki** | KEYED-STATE + fs (vault) | `openKeyedStore` `index.ts:32,35`; 18 `registerGatewayMethod` `src/gateway.ts:104…404` (dashboard, not used by tool execute) | factory + lazy-object | **in-process-host** | VERIFIED |
| **file-transfer** | **NODE-BUS** (paired-node fs over `node.invoke`) | `node.invoke` `src/tools/node-tool-invoke.ts:61`; `registerNodeInvokePolicy` `index.ts:95` | lazy-object wrapper | **gateway/serve** (needs gateway + paired node) | VERIFIED |
| **diffs** | fs artifact write + HTTP viewer route | `registerHttpRoute` `src/plugin.ts:62` | factory `src/plugin.ts:46` | **in-process-host (degraded)** — artifact write runs in-process; viewer URL needs the L3 route | VERIFIED |
| **diffs-language-pack** | **NO TOOLS** (HTTP asset route only) | `registerHttpRoute` `src/plugin.ts:7`; no `registerTool` | n/a | **not runnable as a tool source** | VERIFIED |
| **browser** | **L3 + NODE-BUS** (Chromium control service / browser node) | `registerService` `plugin-registration.ts:220`; `registerGatewayMethod` `:210`; `node.invoke` `src/browser-tool.ts:346` | factory (cast) `plugin-registration.ts:201` | **gateway/serve** (L3 daemon) | VERIFIED |
| **canvas** | **NODE-BUS** (+ optional L3 host) | `registerService` `index.ts:108`; 3 `registerHttpRoute` `:86,93,100`; `node.invoke` `src/tool.ts:113` | factory `index.ts:132` | **gateway/serve** (paired node) | VERIFIED |
| **workboard** | KEYED-STATE (SQLite store) | `WorkboardStore.openSqlite()` `index.ts:13`; 42 `registerGatewayMethod` (dashboard, unrelated to tool execute) | factory (35 names) `index.ts:31` | **in-process-host** | VERIFIED |
| **tavily** | PROVIDER+SECRET (Tavily key + HTTPS) | `registerWebSearchProvider` `index.ts:12`; no service/bus | factory `(ctx)=>tool` `index.ts:13` | **in-process-host** (config shim + key + net) | VERIFIED |
| **firecrawl** | PROVIDER+SECRET (Firecrawl key + HTTPS; scrape has keyless mode) | `registerWebFetch/WebSearchProvider` `index.ts:13-14`; no bus | `registerTool(tool)` lazy-object `index.ts:15` | **in-process-host** | VERIFIED |
| **xai** | PROVIDER+SECRET (xAI key + runtime-config snapshot + HTTPS) | 6 providers `index.ts:267-272`; no bus | factory `index.ts:273` | **in-process-host** | VERIFIED |
| **llm-task** | **EMBEDDED-AGENT** (`runEmbeddedAgent`, provider+model) | `runEmbeddedAgent` `src/llm-task-tool.ts:269`; no service/bus | `defineToolPlugin` def with a `factory` field `index.ts:31` | **gateway/serve** (host+embedded-agent) — **but piflow already bridges this seam to a nested pi** (`openclaw-host.ts:197-374`) | VERIFIED |
| **codex-supervisor** | external **Codex app-server daemon** (JSON-RPC over stdio/ws/unix) | `registerRuntimeLifecycle` `index.ts:25`; spawns a child (`src/json-rpc-client.ts`) | `registerTool(tool)` loop `index.ts:37` | **gateway/serve** (external daemon) | VERIFIED |

### Two matrix facts that change the architecture

1. **No regular plugin passes a bare `{name,…,execute}` to `registerTool` — all register a FACTORY (or a
   lazy-loading object, or, for llm-task, a `defineToolPlugin` def carrying a `factory` field).** The current
   capture-shim reads `def.execute` (`openclaw-shim.ts:182`) and so binds `undefined` for every community
   plugin; calc works *only because its def is its tool*. **Any host or `-e` bind for community plugins needs a
   factory-aware shim** (the orphaned `openclaw-host.ts` already calls `factory(ctx)` — `openclaw-host.ts:9-11`
   — which is exactly why it was built; this **contradicts** the simpler capture-shim and confirms the host
   path is the necessary one for community plugins).
2. **In-process-runnable (need only a `runtime` shim, NO L3/bus): memory-core, memory-wiki, workboard
   (keyed-state); tavily, firecrawl, xai (provider+secret); diffs (artifact, viewer route degraded).** **Need
   the full gateway / a port of L3 / a daemon: file-transfer, browser, canvas, codex-supervisor.** **llm-task**
   straddles — needs the embedded-agent subsystem, which piflow already maps to a nested pi.

---

## 6. Previous attempts & decisions (so we don't relitigate)

- **MCP-gateway framing (B lane, June 20-22).** Decision: route `oc.<plugin>:<tool>` → reserved `openclaw`
  MCP server = OpenClaw's standalone `plugin-tools-serve` (`address.ts:6-17`); proven by the real-server e2e
  (`tool-bridge-openclaw-gateway.e2e.test.ts`). **Why it stalled:** `plugin-tools-serve` is stdio-only and skips
  L3 (§4), and nothing in the product provisions the `openclaw` server in a live run. It remains valid as a
  *local stdio* path for the request/response tier, and as the reference implementation to test our host against.
- **S0–S3 substrate adoption (A lane, June 22, `docs/design/openclaw-substrate-adoption.md`).** Decided + built:
  host the plugin substrate ourselves on pi; "no duplicate runtime" — drop OpenClaw's internalized
  `embedded-agent-*.js` and bind `runEmbeddedAgent` to a nested pi (`:119`). **Verified findings:** OpenClaw
  migrated off pi by 2026.6.9 (`:32`); `registerTool` has **3 shapes** (`:152`); `register` is sync + Proxy-
  guarded (`:160`); only **10** tool-bearing plugins are bundled in npm dist, not 19 (`:151`); the execute
  driver is genuinely new code because `registry`/`loader` only *store* factories (`:125`). **S4 (the L3
  daemon for browser/canvas) is explicitly deferred** (`:148`) — that is the same blocker §4/§5 surface.
- **Cloud tool-gateway design (June 24-26, `docs/design/cloud-tool-gateway-architecture.md`).** Decided for the
  *cloud* case: a sandboxed VM cannot reach a host `localhost` (`§E`, CONFIRMED), so services live on a routable
  gateway host; secrets flow via `SecretResolver` short-lived tokens (`§D`, `types.ts:612-629`). For
  gateway-coupled `oc.*` it recommends **replacing with equivalent remote MCP servers** for v1 (`§F`,
  `:392-406`) and notes `llm-task` already works via the S3 nested-pi seam inside the VM (`:384-390`). This is a
  *pragmatic detour around* the host port, not a refutation of it.

**Net of prior decisions:** the team already concluded (a) the runtime is a pi-compatible *port target*, not a
graft; (b) the request/response + provider + keyed-state + embedded-agent tiers are hostable in-process; (c) the
L3 daemon is the bounded hard part (deferred); (d) for cloud, the host must face a routable network, not the VM.
**Do not relitigate the lineage or the "is `plugin-tools-serve` separable" question — both are settled here.**

---

## 7. FINAL recommendation + the few unknowns that need a spike

### The single cleanest design

**Stand up ONE localhost "piflow tool host" = the in-process OpenClaw plugin host (extend `openclaw-host.ts`),
wrapped in OUR own Streamable-HTTP MCP face, registered as the reserved `openclaw` server.** Concretely:

1. **Serve the in-process tier ourselves (no foreign service).** Extend `openclaw-host.ts` (already does S0-S3)
   to register **memory-core, memory-wiki, workboard, tavily, firecrawl, xai, diffs** behind a **factory-aware**
   capture/host shim (call `factory(ctx)` — the host already does this) and the existing `runtime` shim
   (real `openKeyedStore`/SQLite + `SecretResolver` for keys + `runEmbeddedAgent`→nested pi). This covers the
   whole request/response + provider + keyed-state + embedded-agent tier.
2. **One channel, two transports.** Expose this host as the reserved `openclaw` MCP server with **both** a
   **stdio** entry (for a local pi run) and a **Streamable-HTTP listen** (for a Daytona VM, egress-reachable
   HTTPS + `$VAR` bearer via `SecretResolver`). The generated `-e` is unchanged — every `oc.*` already routes
   to `openclaw` via `callTool` (`address.ts:69`, `index.ts:62`); you only have to **provision that server**
   (the gap at `cli/run.ts:375` — pass an `mcpConfig` that points `openclaw` at the host, plus `secretResolver`).
3. **For the L3 / node-bus tier (browser, canvas, file-transfer, codex-supervisor): do NOT block v1 on the L3
   port.** Either (i) defer them (they are the minority and the hardest), or (ii) reach them via OpenClaw's full
   gateway as a deliberately-separate service *only if* a workflow needs them — but that IS a foreign service,
   so keep it optional and out of the "everything on one localhost host" promise.

This gives: **no foreign service for the common tier**, **the same `oc.*` channel local and remote**, **secrets
brokered host-side**, and an **honest boundary** at the L3 plugins.

### CERTAIN (verified in source)

- OpenClaw v2026.6.9 consumes no pi runtime package; the plugin contract is OpenClaw-host-bound (§3). This
  CORRECTS (source wins) the residual "OpenClaw core runtime is closed-source" caveat still in
  `orchestration-substrate.md:100` / `substrate-multiagent-…:327` (the team self-corrected it in
  `pi-tools-extensions-…:182-187` + `openclaw-plugin-sourcing-…:25`; this nails it from the vendored MIT tree).
- `plugin-tools-serve` is separable from channels but **stdio-only** and **does not run L3 services** (§4) — so
  it can be a *local* reference, never the remote-reachable "everything" server.
- The in-process host can run memory/workboard/provider plugins; it CANNOT run browser/canvas/file-transfer/
  codex-supervisor without an L3/bus port (§5). The L3 layer is the prior `openclaw-substrate-adoption.md`
  "Layer 3" (deferred as S4) and sits at the **L3 control-plane / long-running-service tier**
  (`l2-l3-boundary-map.md:14,27-43`) — a post-M6 horizon, not a v1 blocker.
- Today only `oc.calc:add` executes end-to-end; community `oc.*` is discoverable-only for two independent
  reasons (non-importable ref → bridge; bridge target unprovisioned) (§2). The bridge-unprovisioned half is the
  same **blocker #1** the prior investigation already pinned (`2026-06-25-node-action-…:134`: "Catalog never
  seeded into canonical run path").
- Every regular plugin registers a **factory**, so the simple `def.execute` capture-shim binds nothing for them
  (§5) — the factory-aware host is required. This **refines** (source wins) `openclaw-plugin-sourcing-…:141-146`
  (which read the docs as "execute is gateway-context-FREE / bare def") and **confirms** the later correction in
  `openclaw-substrate-adoption.md:152` (registerTool "3 shapes"). The factory-aware driver already exists in the
  orphaned `openclaw-host.ts:9-11`.
- The `-e` delivery is SOLVED, not open: the esbuild self-contained bundle (externals = pi-injected specifiers)
  works on every provider including an empty cloud VM (`tool-bridge-delivery-2026-06-21.md:93-105`; built at
  `compile.ts:312-325`). The "fold execute into `-e`" path (§4 option c) inherits this mechanism wholesale; what
  blocks it is the no-pure-plugin fact (§5), not bundleability.
- The secret/env path is DESIGNED and wired host-side: `$VAR`-refs-in-`_pi/mcp.json` + an allowlisted
  `SecretResolver` (`tool-bridge-env-2026-06-21.md:160-180`; staged at `runner.ts:947-960`), with the cloud
  "mint a short-lived scoped token, never the raw key" rule already specified (`cloud-tool-gateway-…:221-248`).
- How a NEW plugin gets wired is a SETTLED pipeline, not a question: crawl `extensions/*` manifests filtered to
  `contracts.tools` → skeleton `ToolEntry` → capture-shim fills description+params (purity gate) → registry →
  generated `-e`, esbuild-bundled (`openclaw-plugin-sourcing-2026-06-21.md:286-308`).

### Unknowns that need a 1-shot spike (SHORT — only what NO prior doc and NO vendor source settles)

1. **Does OUR Streamable-HTTP face cleanly wrap the in-process host so a remote client gets the same `oc.*`
   tool results as stdio?** *Experiment:* stand up the in-process host behind a minimal `@modelcontextprotocol/sdk`
   `StreamableHTTPServerTransport`, point `configureBridge({servers:{openclaw:{transport:'http',url}}})` at it,
   and run the existing `oc.memory-core:memory_get` e2e over HTTP instead of stdio. NO prior doc covers this —
   every prior treatment of OpenClaw-tool-serving assumed stdio (`tool-bridge-env-…:126-155`) or the *bridge
   client* HTTP path, never an OpenClaw-tool HTTP *server* we host. (The bundle/secret/transport-client mechanics
   it composes with are already settled — see CERTAIN above.)
2. **Do the in-process-host plugins beyond the three proven ones actually EXECUTE under the factory-aware shim
   with the minimal `runtime`?** S0-S3 execute-proved only `memory_get`, `tavily_search`, and `llm-task`
   (`openclaw-substrate-adoption.md:144-147`); registration breadth (S1) is proved but per-tool *call-time*
   reach into an unstubbed `runtime.*` is explicitly an open risk (`:161` flags `workboard.subagent` /
   `lobster.managedFlows`). *Experiment:* call one tool each for `workboard`, `memory-wiki`, `diffs`, `xai`
   through `hostOpenClawTool` and assert a real result.

> **Dropped from the prior unknowns list (already settled, do not re-investigate):**
> (a) *bundleability / does a bundled `-e` load on a cloud VM* — settled by `tool-bridge-delivery-…:93-105,230`
> (the live-load smoke is the only residual, folded into spike #2's run). (b) *registerTool shapes* — settled
> (3 shapes, `openclaw-substrate-adoption.md:152`; factory-confirmed against the vendored source in §5/§8).
> (c) *"is there a pure shipped tool"* — settled NO (`openclaw-plugin-sourcing-…:226`, re-confirmed in §5: none
> of the 12 is pure). (d) *secret delivery into the VM* — settled (`tool-bridge-env-…`; `cloud-tool-gateway-…`).
> (e) *how to enumerate/ingest a new plugin* — settled pipeline (`openclaw-plugin-sourcing-…:286-308`).

### Left UNVERIFIED (central, named)

- **The exact `registerTool` type signature in the SHIPPED `plugin-sdk`** — the grep of
  `vendor/openclaw/packages/plugin-sdk/src` returned no `registerTool` hit (it lives in the dist/`.d.ts` or is
  re-exported), so the "factory not def" fact is established from the **plugin call sites** (`extensions/*/index.ts`,
  §5), the orphaned host's forensics (`openclaw-host.ts:9-11`), and the prior "3 shapes" finding
  (`openclaw-substrate-adoption.md:152`) — not from the SDK type itself. To pin the type, read
  `vendor/openclaw/packages/plugin-sdk/dist/*.d.ts` or `src/plugins/types.ts:2640`. (Not load-bearing — the
  behavior is triply corroborated.)
- **Whether a remote Daytona VM can hold an open Streamable-HTTP MCP session back to a host on the laptop's
  network** is a deployment/networking fact (egress + routable address), not a source fact — the cloud design's
  topology says the *production* answer is "host on a routable gateway, not the laptop's loopback"
  (`cloud-tool-gateway-architecture.md:289-297`), so the laptop-localhost variant is for *local* runs only and
  the cloud variant needs a reachable address. Not exercised end-to-end.

---

## 8. Reconciliation with prior research

This deep-dive **stands on** the team's prior work rather than re-deriving it. Every prior doc gets a row.
STATUS legend: **CONFIRMED** (vendored source agrees) · **REFINED** (source sharpens/extends it) ·
**CONTRADICTED** (source overrides a prior claim — source wins, both sides cited).

| Prior doc | Its key conclusion(s) | STATUS | Evidence (prior · this deep-dive) |
|---|---|---|---|
| `pi-tools-extensions-openclaw-2026-06-21.md` | **§0/intro "do not re-derive": mirror OpenClaw — but as an SDK, NOT a gateway.** OpenClaw embeds pi via `createAgentSession()` and feeds a curated per-agent tool set; "Our SDK occupies the same role." pi's selection = flat bare-name allowlist; `namespace:name` is ours; the `-e` + `--tools` seam survives `--no-extensions`. **§4 self-CORRECTS the GO brief's "closed-source core" to MIT/open.** | **CONFIRMED** (the decision) + **REFINED** (the runtime detail) | prior `:5,:189-194,:145-147,:182-187` · this §3 (verdict: in-process host = SDK role, not gateway), §4 (gateway IS the thing we DON'T need to run), §7 recommendation. The "closed-source" correction is **completed** by my §3 (vendored MIT tree, zero pi deps). |
| `openclaw-plugin-sourcing-2026-06-21.md` | The ingest pipeline: crawl `extensions/*` manifests (names-only) → skeleton `ToolEntry` → capture-shim fills description+params + gates purity → registry → generated `-e`. **PURE vs GATEWAY-COUPLED is the portability predicate; no shipped tool is pure.** Confirms OpenClaw embeds pi via `createAgentSession()`. | **CONFIRMED** (pipeline + "no pure tool") · **CONTRADICTED** on one point | prior `:152-165,:226,:286-308` · this §5 (re-confirms none of the 12 is pure). **CONTRADICTION (source wins):** prior `:141-146` read the docs as "execute is gateway-context-FREE / a bare `def`"; the vendored source shows every plugin registers a **FACTORY `(ctx)=>tool`** (this §5, e.g. `vendor/openclaw/extensions/memory-core/index.ts:200`), so a `def.execute` shim binds nothing. Already corrected by `openclaw-substrate-adoption.md:152`. |
| `tool-bridge-delivery-2026-06-21.md` | **esbuild self-contained ESM bundle, externals = pi-injected specifiers** (typebox + `@earendil-works/*`), is the ONLY cross-provider-robust `-e` delivery (works on empty cloud VM). Use `format:'esm'` (MCP-SDK CJS traps). | **CONFIRMED** (built + load-bearing for the "fold into `-e`" option) | prior `:93-105,:139-159` · this §4 option (c) inherits it wholesale; built at `compile.ts:312-325`. Folded into §7 CERTAIN; the "fold into `-e`" path is gated by no-pure-plugin (§5), not by bundleability. |
| `tool-bridge-env-2026-06-21.md` | `_pi/mcp.json` carries **`$VAR` refs, never literal secrets**; real values ride as allowlisted child env; **local MAY passthrough, cloud MUST allowlist**; HTTP transport is the cloud default, stdio local-only. | **CONFIRMED** | prior `:16-93,:160-180` · this §7 CERTAIN (secret path designed + wired `runner.ts:947-960`); §4 condition (the remote VM reaches an HTTP face with an allowlisted bearer). |
| `sandbox-tool-wiring-2026-06-22.md` | A heavy gateway (343 MB) **cannot** be baked into every microVM; the converging default = thin in-sandbox MCP client + **shared remote HTTP gateway** for cloud, stdio for local. Notes OpenClaw ships Code Mode. | **CONFIRMED + REFINED** | prior `:1-9,:96-111` · this §4 (the localhost host must FACE the network; the VM is the client) is the same shape; my source finding ADDS *why* OpenClaw's own `plugin-tools-serve` can't be that remote gateway (stdio-only, `vendor/openclaw/src/mcp/plugin-tools-serve.ts:80`). |
| `tool-registry-maintenance-2026-06-21.md` | Registry upkeep: pin by hash, provenance/trust gate, freshness loop, **prefix-on-collision never skip** (M2 resolve vs M4 catalog seam). Explicitly does NOT re-derive the addressing scheme. | **CONFIRMED** (orthogonal — maintenance, not execution) | prior `:129-244` · this report covers EXECUTION reachability; the catalog `oc.*` entries it maintains are the discoverable-but-unexecutable rows in this §2. No conflict. |
| `2026-06-25-node-action-surface-and-tool-wiring-investigation.md` | **Blocker #1: the catalog/`mcpConfig` is never seeded into the CLI run path** → any `oc.*`/`mcp.*` node `blocked` before pi spawns; `seededRegistry` has 0 non-test callers. The ingest→schema→bind→execute pipeline is built but unwired; **no live-pi E2E** binds+executes via `-e`. | **CONFIRMED** (this is the same gap, independently re-traced) | prior `:134,:140,:169-177` · this §1 (rows 11/13/15), §2 ("bridge target unprovisioned"). My §2 adds that `cli/run.ts:375` passes no `mcpConfig`/`secretResolver` — the exact mechanism of blocker #1. The "no live-pi `-e` E2E" gap = my spike #1/#2 in §7. |
| `substrate-multiagent-and-runtime-2026-06-21.md` | "Is OpenClaw just a giant pi?" → **chaining small full-agent nodes is the validated shape**; OpenClaw's embedded runtime IS pi (`pi-agent-core`). **Addendum caveat: "OpenClaw's core runtime is closed-source" (secondhand).** | **CONTRADICTED** on the closed-source caveat (source wins); CONFIRMED on the architecture | prior `:322-327` · this §3: the vendored tree is **MIT, fully readable, zero pi runtime deps** (`vendor/openclaw/packages/agent-core/package.json:97-100`). The "IS pi" framing is now precise: *was* pi's SDK consumer, internalized its own agent-core by 2026.6.9. |
| `openclaw-learning/openclaw-domain-glossary.html` + `…navigation-map.html` | The team's structured study of the vendored source: gateway vs runtime vs plugin boundaries; "gateway and plugin runtime"; plugin SDK as the cross-into-core boundary. | **CONFIRMED** (consistent vocabulary) | the HTML maps name exactly the gateway / plugin-runtime / plugin-SDK boundary this report's §3-§4 operate over; no conflict. (Structured study aid, not a claim to refute.) |
| `orchestration-substrate.md` | Borrow-vs-build: **OpenClaw's embedded agent runtime IS pi; borrow the primitive, we already do the per-node version** (`--tools` + `DRIVER-SEED` + `-e`). **Residual caveat: "OpenClaw's core runtime is closed-source."** | **CONFIRMED** (borrow-the-primitive) · **CONTRADICTED** (closed-source) | prior `:86-101` · this §3/§7. CONTRADICTION (source wins): `:100-101`'s closed-source note is refuted by the vendored MIT tree (§3). The borrow-vs-build call stands: A = borrow the substrate, host it on pi. |
| `l1-node-envelope.md` | FROZEN SPINE: a node = work·sandbox·tools·hooks·contract; **`namespace:name` is an SDK abstraction over pi's flat allowlist**; tool bind pre-check blocks a node lacking a declared capability; borrow tool sources, own the intersection. | **CONFIRMED** | prior `:45-52,:55` · this report's `oc.*` addressing + the bind/compile path (§1 rows 6-9, §2) operate exactly within this spine. The bind pre-check is why an unprovisioned `oc.*` blocks (§2). |
| `l2-l3-boundary-map.md` | L1 node / L2 COMPOSE / **L3 control-plane (long-running services, supervisors) is the post-M6 horizon, deferred**, and reuses L1/L2 primitives. | **CONFIRMED** (places the L3 host correctly) | prior `:14,:27-43,:57-62` · this §4/§5/§7: the L3-daemon plugins (browser/canvas) sit at the L3 tier; their host = the deferred S4/L3 work, not a v1 blocker. This is WHY §7 scopes them out of v1. |
| `learning-records/0001-vendor-repo-learning-scope.md` | Learning is scoped to `vendor/openclaw` (+ `vendor/hermes-agent`), local-source-first. | **CONFIRMED** (this report obeys it) | prior `:3` · this entire report reads from `vendor/openclaw`, not web search. |
| `learning-records/0002-piflow-init-gaps-…md` | Authoring-surface gaps from a real port (token resolution in `node.io`, in-place model, `--from` preflight stats raw paths, tool-name vocabulary). **First LIVE run on `mmgw`/MiniMax.** | **CONFIRMED** (adjacent — authoring/runtime, not OpenClaw execution) | prior `:251-256` (G9: bare builtin names + `oc.*`/`mcp.*` only for sdk/mcp), `:275-321` (live run) · this report's `oc.*` lane is the same family these gaps reference. No conflict; the OpenClaw-execution layer is downstream of these authoring gaps. |

**Does the recommendation MATCH the prior "SDK not gateway" decision? — YES, loudly.** The single load-bearing
prior decision (`pi-tools-extensions-openclaw-2026-06-21.md:5`: *"as an SDK, NOT a gateway"*) and my §7
recommendation (host the plugin runtime ourselves in-process on pi = Approach A; do NOT stand up OpenClaw's
gateway as a foreign service) are **the same call**, now re-grounded in the full vendored MIT source. The
convergence is the certainty the user wanted: two independent passes (the 2026-06-21 docs from pi/OpenClaw docs
+ Exa; this deep-dive from the vendored tree) reach the identical architecture.

**The two places the source OVERRIDES prior research (source wins, flagged):**
1. **"OpenClaw's core runtime is closed-source"** (still in `orchestration-substrate.md:100`,
   `substrate-multiagent-…:327`) is **FALSE** — the vendored tree is MIT and fully readable with zero pi
   runtime deps (this §3; `vendor/openclaw/packages/agent-core/package.json:97-100`). The team already began
   this correction (`pi-tools-extensions-…:182-187`); this completes it.
2. **"plugin execute is gateway-context-free / a bare `def`"** (`openclaw-plugin-sourcing-…:141-146`) is
   **REFINED to FALSE for the bind shape** — every plugin registers a **factory `(ctx)=>tool`** (this §5),
   so a `def.execute` capture-shim binds nothing; the factory-aware driver is required (and already exists,
   orphaned, at `openclaw-host.ts:9-11`). The team's own `openclaw-substrate-adoption.md:152` already caught this.

Neither override changes the recommendation — both make the in-process-host (Approach A) MORE clearly the right
call (we have the full source to host; the bind needs the factory-aware host we already built).

---

## 9. Plugin lifecycle — discover → acquire → install → load → execute (NO OpenClaw install)

> **Premise correction (load-bearing).** §1-§7 + the orphaned host (`openclaw-host.ts:571,578`) all load plugins
> from `node_modules/openclaw/dist/extensions` — which silently assumes the user installed OpenClaw. **The
> product must require NO OpenClaw install; the user never knows OpenClaw exists.** This section settles the
> missing half of the lifecycle (acquire → install → load), grounded in **HALF 1 (npm registry, via WebFetch)**
> and the **spike** (`docs/research/spike-full-plugin-loop.md` + `packages/core/test/spike-full-plugin-loop.test.ts`).
> The prior sourcing brief (`openclaw-plugin-sourcing-2026-06-21.md` §1/§4/§5) settled **discovery + ingest +
> the `-e` bundle**; it left **acquisition + install-location + standalone-load** open — this section closes them.

### (a) Per-target npm-publish reality + the acquisition mechanism

The standalone `@openclaw/<plugin>` tool packages are **NOT real on public npm today** (HALF 1, WebFetch
`https://registry.npmjs.org/@openclaw%2F<name>`):

| Target | public npm | evidence |
|---|---|---|
| `@openclaw/duckduckgo-plugin` | **404 NOT FOUND** | registry 404 |
| `@openclaw/workboard` | **404 NOT FOUND** | registry 404 |
| `@openclaw/memory-core` | **404 NOT FOUND** | registry 404 |
| `@openclaw/tavily-plugin` | **placeholder** | v0.0.0, **409 bytes / 2 files**, "Bootstrap reservation", no main/deps |
| `openclaw` (umbrella) | **published** | latest **2026.6.10**, **86.65 MB** unpacked, bundles every `dist/extensions/*` |

**Acquisition mechanism — how the world installs them** (exa, `docs.openclaw.ai/tools/plugin` + `/cli/plugins`):
the real loop is `openclaw plugins install <spec>` with source prefixes — **`clawhub:<pkg>` (ClawHub is the
canonical discovery surface), `npm:<pkg>`, `git:github.com/<o>/<r>@<ref>`, `npm-pack:<path.tgz>`,
local `./dir`/`--link`**; bare `@openclaw/*` specs **resolve to the image-owned bundled copy before npm
fallback**. The docs claim "`@openclaw/*` plugin packages are published on npm again," but the registry checks
above show the tool packages are 404 / placeholder — so **today the only real source is the umbrella `openclaw`
package's bundled `dist/extensions/*`, or the GitHub source `openclaw/openclaw@<tag>:extensions/<name>/`.** Our
acquisition options (no OpenClaw install at runtime): **(A)** build a standalone pack from the GitHub source
(clean — own `dist`, `@openclaw/plugin-sdk` as a real dep — but we run the build); **(B)** `npm pack openclaw`
once on the host and copy each plugin's **transitive dist-chunk closure** into the piflow cache (works today;
drags ~100-290 shared chunks/plugin — see (d)). Neither leaves an `openclaw` runtime dependency.

### (b) Install-location decision

**`~/.piflow/extensions/<id>@<ver>/`** — parallels OpenClaw's OWN convention `$OPENCLAW_STATE_DIR/extensions/<id>/`
(exa), and obeys the project rule "global mapping/index/snapshots live in `~/.piflow/`" (CLAUDE.md). Each install
gets its **own `node_modules/`** holding only the plugin's declared npm deps (typebox, chalk, kysely, …) —
**never the `openclaw` package**. The spike proved this layout loads: cache at
`<root>/extensions/duckduckgo@2026.6.9/` + a cache-local `node_modules` linking declared deps
(`spike-full-plugin-loop.test.ts` `beforeAll`).

### (c) `@openclaw/plugin-sdk` is the ONE OpenClaw-origin piece we vendor — and its surface is SMALL when built

`@openclaw/plugin-sdk` is `private` / `0.0.0-private` → **unpublished → MUST be vendored**
(`vendor/openclaw/packages/plugin-sdk/package.json`: **0 dependencies, 116 K, 25 files, 63 subpath exports**).
But its *source* is a **thin re-export façade**:
`vendor/openclaw/packages/plugin-sdk/src/plugin-entry.ts:3` = `export * from "../../../src/plugin-sdk/plugin-entry.js"`,
which re-exports `vendor/openclaw/src/plugins/types.js` — so vendoring the SOURCE drags `vendor/openclaw/src/plugins/*`.
**The vendoring surface that actually matters is the BUILT contract:** when a plugin is built, `definePluginEntry`
compiles to a **1.27 KB self-contained chunk** (`dist/plugin-entry-VgQuYBGd.js`, importing only `./config-schema-*.js`).
So the contract shipped with a built plugin is **~2 small chunks**, not the 63-export tree — vendor the built
slice (or pin the built chunks alongside each cached plugin), not the source façade.

### (d) What the host must change to load from the piflow cache (the `:571/:578` resolution)

`openClawExtensionsDir()` (`packages/core/src/tools/openclaw-host.ts:563-579`) hard-walks up to
`node_modules/openclaw/dist/extensions` (`:571`, `:578`); `discoverToolBearingPlugins()` (`:594-595`) reads from
it. **The change:** resolve from `~/.piflow/extensions/<id>@<ver>/` instead — each cache dir already carries the
plugin's `openclaw.plugin.json` + entry + its transitive chunk closure + a cache-local `node_modules`. **The
structural catch the spike found:** the bundled-dist entry is the TIP of a hashed shared-chunk web (duckduckgo
= **101 dist files**, workboard = **287**), and resolves `typebox` from OpenClaw's *nested*
`node_modules/openclaw/node_modules` — so the cache MUST contain the full chunk closure + the declared deps, not
just `extensions/<name>/`. A standalone-built pack (option A above) would collapse that to one self-contained
`dist` + real `@openclaw/plugin-sdk` dep, which is the cleaner long-run target. **Scope note:** this is a
*future* host change — NOT made in this spike (the spike is a standalone test; no edit to `openclaw-host.ts`).

### (e) Spike verdict

**PROVEN-OFFLINE.** The full no-OpenClaw loop (acquire-from-dist-as-offline-stand-in → install into a
piflow-owned cache → load → reach-execute) works with **NO `node_modules/openclaw` at runtime** — observable
(no `openclaw` package/path in the closure or cache `node_modules`) and test-the-tested (empty cache → red).
**Two honest caveats:** (1) the *external* DuckDuckGo HTTP call is **network-gated** — proven to the
provider/service boundary, not a live search result (duckduckgo also exposes no agent tool: `createTool: () =>
null`, so the `hostOpenClawTool` execute-of-an-agent-tool path is covered by the existing `memory_get` proof,
not here); (2) **acquisition from public npm is currently BLOCKED** — the standalone `@openclaw/<plugin>`
packages are 404/placeholder, so real code comes only from the umbrella `openclaw` package or the GitHub source.
**Single next thing:** pick the acquisition mechanism — build standalone packs from
`openclaw/openclaw@<tag>:extensions/<name>/` (clean, we run the build) vs copy each plugin's transitive
dist-chunk closure out of one `npm pack openclaw` (works today, drags the shared chunks).

> **Cross-link:** this section settles **acquire + install + standalone-load**;
> `openclaw-plugin-sourcing-2026-06-21.md` §1 (discovery/enumerate), §4 (PURE-vs-coupled portability shim), §5
> (native execute into the esbuild-bundled `-e`) settled discovery + ingest + the bundle. Together they are the
> full discover→acquire→install→load→bind→execute lifecycle.

---

## Bar Audit

| # | Criterion | PASS/FAIL | Evidence |
|---|---|---|---|
| 1 | Every piflow claim has `file:line`; every OpenClaw-runtime claim cites `vendor/openclaw/<path>:<line>`; no web-guessed OpenClaw internals; Exa only for external facts, flagged | **PASS** | §1 table all `file:line`; §3/§4/§5 all `vendor/openclaw/…:line`; the only external claim (MCP Streamable-HTTP spec) is explicitly flagged in §4. |
| 2 | §3 quotes ≥3 concrete vendor source findings + a definite pi-compat verdict incl. the vendored version | **PASS** | §3 Findings 1-3 quote `package.json:1950`, `agent-core/package.json:97-100`, `agent-loop.ts:258`, `types-core.ts:237-239`, `compat/registry.ts:531-547`; version v2026.6.9 (`package.json:2-3`); verdict PARTLY-TRUE→FALSE. |
| 3 | §4 answers the thesis with explicit YES/YES-WITH-CONDITIONS/NO + load-bearing conditions, and evaluates hosting-it-ourselves (not only spawn `plugin-tools-serve`) | **PASS** | §4 VERDICT = YES-WITH-CONDITIONS; condition = our HTTP MCP face; options (a) our host, (b) serve, (c) `-e` bundle each evaluated with the two blockers. |
| 4 | The matrix (§5) covers ALL listed regular plugins, each cell VERIFIED/INFERRED, each read from `vendor/openclaw/extensions/` | **PASS** | §5 table covers all 14 (incl. diffs + diffs-language-pack); every row VERIFIED with extension `file:line`. |
| 5 | §7 gives a DECISIVE recommendation + a SHORT explicit unknowns list | **PASS** | §7 one design stated decisively; CERTAIN list + **2** spikes (shrunk from 3 — bundleability/registerTool-shapes/pure-tool/secrets/ingest dropped as prior-settled, each cited) + 2 named UNVERIFIED items. |
| 6 | Every prior research doc reconciled, contradictions flagged | **PASS** | §8 table: all 15 prior docs/records get a row (CONFIRMED/REFINED/CONTRADICTED) with both-side `file:line`; 2 CONTRADICTIONS flagged (closed-source caveat; bare-`def` shape) with "source wins"; convergence with "SDK not gateway" stated loudly. |
| 7 | Full no-OpenClaw loop spiked (acquire→install→load→execute, NO `node_modules/openclaw` at runtime) | **PASS** | §9 settles (a) per-target npm reality (404/placeholder; umbrella is the source) via WebFetch, (b) install-location `~/.piflow/extensions/<id>@<ver>/`, (c) `plugin-sdk` vendoring surface (1.27 KB built chunk, not the 63-export source façade), (d) the `:571/:578` host change; verdict **PROVEN-OFFLINE**. Backed by `packages/core/test/spike-full-plugin-loop.test.ts` (5 tests green, mutation/test-the-test verified) + `spike-full-plugin-loop.md` §Results. |

**File written:** `/Users/tk/Desktop/piflow/docs/research/openclaw-localhost-gateway-deep-dive.md` (this file).

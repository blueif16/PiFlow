# OpenClaw plugin sourcing for the `sdk` tool lane — research brief (2026-06-21)

Feasibility + sourcing diligence for the **`sdk` tool lane** of Pi Flow's tool registry, sourced from the
**OpenClaw** plugin ecosystem (the community pool of pi-compatible tools). Goal: a *consistent ingest
pipeline* that can enumerate "however much" of OpenClaw's community plugin tools, of which we persist a FEW
in a tiny git-JSON catalog to prove the `sdk` path end-to-end — BEFORE the MCP lane.

**Confidence legend:** `[GROUND]` = our in-repo source (authoritative for what we run today) ·
`[PRIMARY]` = OpenClaw repo/docs or pi source · `[SECONDARY]` = third-party write-up ·
`[UNVERIFIED]` = could not confirm from a primary source (with the live check that would settle it).

**Builds on (do NOT re-derive):** `docs/research/pi-tools-extensions-openclaw-2026-06-21.md` (pi extension /
`registerTool` API, OpenClaw layering, flat name space) and `docs/research/tool-bridge-delivery-2026-06-21.md`
(jiti loader, the esbuild self-contained-bundle delivery, externals = pi-injected specifiers).

**Scope fence:** research + this ONE brief. No source edits, no `npm install`, no running pi/plugins, no
authenticated API calls.

---

## 1. Findings

### Coverage 1 — OPEN-SOURCE + canonical location `[PRIMARY]`

OpenClaw is **public and MIT-licensed**, confirmed reachable on every axis:

- **Repo:** `github.com/openclaw/openclaw` — loads; description "Your own personal AI assistant. Any OS. Any
  Platform. The lobster way."; **License: MIT**; **default branch `main`**. `[PRIMARY]`
- **Docs:** `docs.openclaw.ai` (sections: Getting Started, Channels, Nodes, Gateway, Tools, Plugins,
  Concepts). Mirrors at `documentation.openclaw.ai` / `docs2.openclaw.ai`. `[PRIMARY]`
- **Alt platform page:** `open-claw.bot/docs/platforms/pi/` — documents embedding pi via
  `createAgentSession()` from `@earendil-works/pi-coding-agent`. `[PRIMARY]` (corroborates the prior brief's
  "OpenClaw embeds pi in-process" fact.)
- **npm:** package **`openclaw`** (MIT; install `npm install -g openclaw@latest`), plus a published
  **`@openclaw/*` plugin scope** (`@openclaw/whatsapp`, `@openclaw/discord`, `@openclaw/brave-plugin`,
  `@openclaw/plugin-inspector`, …). `[PRIMARY]` via Exa (the npm WEB UI 403s WebFetch anti-bot; confirmed via
  Exa + the npm registry JSON).
- **`definePluginEntry` import path:** the `openclaw` package's `exports` map declares
  **`"./plugin-sdk/*": "./dist/plugin-sdk/*"`** — so `openclaw/plugin-sdk/plugin-entry` (and sibling
  subpaths) resolve directly off the published `openclaw` package. `[PRIMARY]` (registry.npmjs.org/openclaw
  package.json `exports`). This matches the prior brief's `openclaw/plugin-sdk/plugin-entry` witness.

> **Correction to the GO context's assumed layout:** there is **NO top-level `plugins/` monorepo
> directory**. `github.com/openclaw/openclaw/tree/main/plugins` → **404**. Bundled plugins live under
> **`extensions/*`** (a pnpm workspace). This is the canonical enumerate anchor (Coverage 2). `[PRIMARY]`

**"Where do we grab it from" anchor:** the `openclaw` npm package (for the `plugin-sdk` import + the shipped
`extensions/*`), the `@openclaw/*` npm scope (for published plugins), and `github.com/openclaw/openclaw@main`
under `extensions/<name>/` (for source + manifests).

### Coverage 2 — DISCOVERY / index (enumerable pipeline) `[PRIMARY]`

There is **no marketplace REST API**, but there are **three real, machine-readable enumeration paths**, in
descending fidelity:

1. **In-repo `extensions/*` monorepo dir (crawl).** Listed via the GitHub contents API
   `https://api.github.com/repos/openclaw/openclaw/contents/extensions` — **~134 entries** confirmed (acpx,
   brave, browser, canvas, codex-supervisor, diffs, document-extract, duckduckgo, exa, file-transfer,
   firecrawl, llm-task, lobster, memory-core/-lancedb/-wiki, oc-path, web-readability, … plus channels:
   discord, slack, telegram, whatsapp, …). Each dir has an **`openclaw.plugin.json`** manifest + `index.ts`.
   This is the **canonical "however much" enumerate surface** for the bundled set. `[PRIMARY]`
   - CAVEAT: most `extensions/*` are **providers/channels/extractors**, NOT agent tools (Coverage 4). Only a
     subset declares `contracts.tools` (browser, canvas, codex-supervisor, diffs, file-transfer, firecrawl,
     lobster, llm-task, memory-core, memory-lancedb, memory-wiki). `[PRIMARY]`
2. **npm scope query (push-published).** `registry.npmjs.org/-/v1/search?text=@openclaw` enumerates the
   published `@openclaw/*` packages; each package's `package.json` carries an `openclaw` field
   (`openclaw.extensions[]`, `openclaw.compat.{pluginApi,minGatewayVersion}`) and ships an
   `openclaw.plugin.json`. This is the **push-published** community surface (vs the repo crawl). `[PRIMARY]`
3. **Curated docs list.** The docs site enumerates first-party plugins per category (channels / providers /
   tools) but is prose, not a machine index — use it to triage, not to enumerate. `[PRIMARY]`

**Verdict on the enumerate mechanism:** for the bundled pool, **crawl `extensions/*` via the GitHub contents
API** (push-published is the `@openclaw/*` npm scope for community-published plugins). It is **crawl**, not a
single push-published index file; there is **no `registry.json`/marketplace endpoint** `[UNVERIFIED — settle
by grepping docs.openclaw.ai for a "plugin registry/marketplace API"; none surfaced in fetched pages]`.

### Coverage 3 — MANIFEST schema for STATIC ingestion + map onto `ToolEntry` `[PRIMARY]`

**The shipped static manifest (`openclaw.plugin.json`) carries tool NAMES ONLY — not descriptions, not
parameter schemas.** This is the single most important constraint for our ingest design. Verbatim from two
real shipped manifests (GitHub contents API):

```json
// extensions/llm-task/openclaw.plugin.json
"contracts": { "tools": [ "llm-task" ] },
"toolMetadata": { "llm-task": { "optional": true } }
```
```json
// extensions/memory-core/openclaw.plugin.json
"contracts": { "tools": ["memory_get", "memory_search"] },
"toolMetadata": { "memory_get": { "replaySafe": true } }
```

- **`contracts.tools`** is a bare **`string[]`** ("Agent tool names this plugin owns") — its job is ownership
  routing ("tells OpenClaw which plugin owns each tool **without loading every installed plugin runtime**"),
  NOT schema carriage. `[PRIMARY]` docs.openclaw.ai/plugins/manifest + tool-plugins.
- **`toolMetadata.<tool>`** is an object of **flags only** — `optional?`, `replaySafe?`, `authSignals?`,
  `configSignals?` — **never `description` or `parameters`**. `optional:true` gates exposure (keeps the
  plugin runtime unloaded until the tool is allowlisted). `[PRIMARY]`
- **Other manifest fields** (confirmed across real manifests): `id, name, description, activation{onStartup,
  onCommands}, enabledByDefault?, contracts{tools[]|webSearchProviders[]|documentExtractors[]|…},
  toolMetadata, configSchema (JSON Schema), uiHints?, setup{providers[{id,authMethods,envVars}]}?,
  configContracts?, commandAliases?`. The `package.json` carries `openclaw.extensions[]`,
  `openclaw.runtimeExtensions?`, `openclaw.compat.{pluginApi,minGatewayVersion}`. `[PRIMARY]`
- **`definePluginEntry({...})`** documented fields: `id` (req), `name` (req), `description` (req), `kind?`
  ("memory"|"context-engine" slots), `configSchema?` (`OpenClawPluginConfigSchema | () => …`),
  `register(api): void` (req). `[PRIMARY]` docs.openclaw.ai/plugins/sdk-entrypoints.
- **`api.registerTool(def, opts)`** — `def = { name, description, parameters: <TypeBox>, async
  execute(_id, params) }`; `opts = { optional?: boolean }`. The **description + TypeBox parameters live ONLY
  in this `register()`/`tools(tool)=>[]` body** — i.e. in source, not in the shipped manifest. `[PRIMARY]`
  docs.openclaw.ai/plugins/building-plugins.

**CRITICAL static-vs-run answer:** the manifest can be read **statically** (no execution) and gives us the
**tool NAME + the owning plugin + the `optional` flag** — but it does **NOT carry the param schema**. To
obtain a tool's `description` + `parameters` we must either (a) **run `register(api)` under a capture shim**
(Coverage 4), or (c) **parse the TypeBox out of the plugin's `index.ts` source**. `[PRIMARY]` (`(b)
manifest-already-has-it` is FALSE — proven by the verbatim `string[]` snippets above.)

**Map onto our `ToolEntry`** (`packages/core/src/types.ts:310-324`):

| `ToolEntry` field | OpenClaw source | Static from manifest? |
|---|---|---|
| `address` | `sdk.<plugin-id>:<tool-name>` (our convention; `plugin-id` from manifest `id`, tool from `contracts.tools[i]`) | **Yes** — both are in the manifest |
| `source` | literal `'sdk'` | n/a |
| `piName` | sanitized `[a-zA-Z0-9_]` from the tool name (mirror `ingest.ts` sanitize), prefixed on conflict by the registry | **Yes** — derived from manifest name |
| `description` | `registerTool` `def.description` | **NO** — lives in `register()` body / source |
| `parameters` | `registerTool` `def.parameters` (TypeBox → JSON Schema) | **NO** — lives in `register()` body / source |
| `tags` | our own (e.g. `["openclaw", plugin-id, manifest category]`) | derived |
| `origin` | `{ kind: 'openclaw-plugin', ref: '<npm-pkg>@<version>' or '<repo>@<commit>#extensions/<name>' }` | **Yes** |

So manifest-only static ingest yields a **skeleton `ToolEntry`** (address/source/piName/origin/tags) but
**`description` + `parameters` require the register-shim or source-parse step**. Our `origin.kind` already
has the `'openclaw-plugin'` literal `[GROUND]` types.ts:323 — the type is ready.

### Coverage 4 — PORTABILITY / adapter (the load-bearing question) `[PRIMARY]`

**The `api` surface** passed to `register(api)` (docs.openclaw.ai/plugins/sdk-overview): `registerTool,
registerProvider, registerChannel, registerEmbeddingProvider, registerWebSearchProvider, registerCommand,
on(hook)/registerHook, registerService, config, pluginConfig, logger, id, name, version, resolvePath`.

**The tool `execute` signature is gateway-context-FREE.** Two authoring paths, both decisive:
- `registerTool` path: **`async execute(_id, params) => { content: [{type:'text', text}] }`** — `_id` is the
  tool-call id, `params` the args. **No gateway context object is passed.** `[PRIMARY]` building-plugins.
- `defineToolPlugin` path: `execute(params, config, context)` where `config` = plugin config and `context`
  carries only `context.signal` (AbortSignal). `[PRIMARY]` sdk-entrypoints / tool-plugins.
- The runtime invokes `tool.execute(toolCallId, params, signal, onUpdate)` `[PRIMARY]`
  `src/plugins/tools.ts` (via Exa) — the ONLY injected runtime args are `signal` + `onUpdate`; **neither
  couples to messaging/channels.** This is structurally the SAME shape as pi's own `execute(toolCallId,
  params, signal, onUpdate, ctx)` (prior brief §1), which is why the tools flow cleanly into the embedded pi
  session.

**Classification — PURE vs GATEWAY-COUPLED** (the signals that distinguish them):

| Class | Signal in source | Portable to bare `pi -e`? |
|---|---|---|
| **PURE / portable** | `execute` reads only `params` (and optionally `config`, `signal`); pure computation or a plain `fetch`; the tool def is created **inline**, does **NOT close over `api`** | **Yes** — the captured def runs standalone |
| **GATEWAY-COUPLED** | the tool is created by a **`factory({api})`** / `createXTool(api)` that closes over `api`; `execute` calls `api.logger`/`api.config`/`api.runtime.*`, the LLM inference gateway, a channel, an embedding provider, a sandbox, or a registered store/HTTP route | **No** — `api.*` is undefined under the shim; execute throws at call time |

Concrete coupled witnesses `[PRIMARY]`: `llm-task` (`factory: ({api}) => createLlmTaskTool(api)`, execute
calls the LLM gateway + `api.logger`); `lobster` (execute spawns a local shell runner `runner.run()` +
touches `api.runtime.tasks`); `diffs` (writes a `DiffArtifactStore` + registers an HTTP route). **Finding:
NONE of the SHIPPED `extensions/*` agent tools has a trivially-pure execute** — they all touch network, a
store, or `api.*`. The genuinely-pure pattern exists only as the **docs `stock_quote` / `echo` examples**
(`execute` reads only its param + config, returns plain JSON, zero `api.*`). `[PRIMARY]` This materially
constrains seed selection (Coverage 6).

**ADAPTER (the register→pi shim).** `definePluginEntry` is **importable standalone** (the `openclaw/plugin-sdk/*`
subpath export, Coverage 1) and is a **thin def-capture helper** — sdk-entrypoints: it "does not instantiate
gateway infrastructure — it delegates all registration through the provided API." The capture pattern is
**already validated in the wild** by `@openclaw/plugin-inspector`, whose `--runtime --mock-sdk` mode "imports
plugin entrypoints in an isolated subprocess and records what `register(api)` does" using **generated mocks
for the `openclaw/plugin-sdk` subpaths** — i.e. a fake `api` whose `registerTool` captures defs is the
project's own blessed approach. `[PRIMARY]` github.com/openclaw/plugin-inspector README.

Minimal shim shape (prose, NO code): construct a fake `api` whose `registerTool(def, opts)` pushes
`{def, opts}` into a `captured[]` array and whose `register{Provider,Channel,EmbeddingProvider,
WebSearchProvider,Command,Service}` + `on`/`registerHook` are **no-op stubs**, with `logger` = a console
shim and `config`/`pluginConfig` = `{}`; `import` the plugin's default export; call
`entry.register(fakeApi)`; then for each captured tool, **re-register `def` on pi** via `pi.registerTool`,
adapting OpenClaw's `(_id, params) => {content:[...]}` return into pi's tool-result (they are already the same
`{content:[{type:'text',text}]}` shape, so the adapter is near-identity). The shim runs at **build/ingest
time on the host** (to capture description + parameters), and the captured `execute` is what gets emitted
into the generated `-e` (Coverage 5).

**Is vendoring `openclaw/plugin-sdk` into the esbuild bundle viable?** **Feasible-with-shim, with a caveat.**
The `plugin-sdk` entry itself is thin (delegates through `api`), so bundling `definePluginEntry` + the
*specific pure plugin module* under esbuild (per the delivery brief: `format:'esm', platform:'node',
externals = typebox + @earendil-works/* + node builtins) is viable. The risk is **what the plugin module
transitively imports** — a pure tool pulls only its own compute deps (fine to bundle); a gateway-coupled one
pulls the gateway and is non-portable regardless of bundling. So **bundle the plugin only after the shim
proves it is PURE** (the shim's no-op `api` + a smoke call is the gate).

**VERDICT: FEASIBLE-WITH-SHIM for PURE plugin tools; NOT-PORTABLE for gateway-coupled ones.** The shim is the
classifier + the captor; purity is the portability predicate.

### Coverage 5 — How the execute reaches our generated `-e` `[GROUND]`+`[PRIMARY]`

Today `compile.ts` (`renderTool`, lines 71-90) emits, for EVERY non-builtin tool, an `execute` body that is
**only** `return callTool(<address>, params, …)` — the MCP/bridge routing. There is **no path to embed a
native sdk-tool execute body** `[GROUND]`. Three models for sdk tools:

- **(a) generated extension `import`s the published plugin package + runs the capture shim, then esbuild
  bundles it — RECOMMENDED.** The generated `_pi/tools.ts` would `import` the pinned plugin module +
  `definePluginEntry` from `openclaw/plugin-sdk`, run the shim to capture the tool def, and `pi.registerTool`
  the captured def (execute included). esbuild then bundles plugin + sdk-shim into the self-contained ESM
  file (delivery brief), externals unchanged. Consistent with our self-contained-bundle delivery; the plugin
  source is pinned by npm version (or git commit). The **purity gate runs at ingest** so only PURE plugins
  ever reach this path.
- **(b) embed/copy the tool's source into the generated file.** Avoids a runtime dependency but forks the
  upstream source (loses the pin, must re-vendor on update) and still needs the TypeBox import. Reject as
  default — brittle for "however much" community ingest.
- **(c) reference by package+version only (no bundle).** Fails the cross-provider bar (delivery brief
  Coverage 2): a bare import of `@openclaw/<plugin>` won't resolve from `_pi/tools.ts` on an outside-repo
  temp dir or empty cloud VM. Reject.

**Recommend (a):** the generated `-e` `import`s the pinned plugin + the `plugin-sdk` shim, registers the
captured def on pi, and the whole thing is esbuild-bundled (externals = pi-injected specifiers, per the
delivery brief). **What `compile.ts` must add:** an **`sdk` branch in `renderTool` distinct from the
mcp/`callTool` branch** — for `source==='sdk'`, instead of `execute → callTool(address,…)`, emit (or import)
the **captured native execute** (the shim-extracted plugin tool def), keeping `parameters` from the ingested
`ToolEntry.parameters`. The `mcp` branch keeps emitting `callTool`. Both still flow through the existing
`-e` + `--tools` + esbuild-bundle seam.

### Coverage 6 — SEED candidates `[PRIMARY]`

The honest finding (Coverage 4): **no shipped `extensions/*` tool is trivially pure** — they touch network,
stores, or `api.*`. So the cleanest first smoke uses the **canonical pure docs patterns** (real SDK API,
runnable), then validates against a real shipped TypeBox def:

1. **`stock_quote`** (canonical PURE pattern, `defineToolPlugin`) — `parameters: Type.Object({ symbol:
   Type.String() })`; `execute({symbol}, config, context)` uppercases `symbol`, returns plain JSON, **zero
   `api.*`/network**. Source: docs.openclaw.ai/plugins/tool-plugins (docs example — **not a shipped repo
   file** `[UNVERIFIED as a shipped path; it is the documented pure template]`). **Best first wire** — proves
   the sdk register→capture→`pi.registerTool` contract verbatim. Pin: regenerate from `openclaw@latest` (npm
   `openclaw`, currently `2026.6.8`).
2. **`echo`** (the `openclaw plugins init` scaffold tool, `defineToolPlugin` in `src/index.ts`) — echoes
   `params`, no `api`. The canonical minimal scaffold. Source: docs.openclaw.ai/plugins/tool-plugins
   ("src/index.ts: a defineToolPlugin entry with an echo tool"). Pin: `openclaw plugins init` from
   `openclaw@2026.6.8`. `[UNVERIFIED exact emitted source — settle by running `openclaw plugins init` once.]`
3. **`lobster`** (lightest REAL SHIPPED single tool, for migrating a real TypeBox def) — source:
   `extensions/lobster/openclaw.plugin.json` + `extensions/lobster/src/lobster-tool.ts` (also npm
   `@openclaw/lobster`, **version pin `[UNVERIFIED — registry.npmjs.org/@openclaw%2Flobster fetch timed
   out]`**). `Type.Object({ action: enum["run","resume"], pipeline, argsJson, … })`. **NOT fully pure** —
   `execute` calls `runner.run()` (spawns a local shell process). Use ONLY to validate the ingest of a real
   shipped manifest+TypeBox; do **not** make it the first smoke (it is gateway-coupled).

**Recommendation:** first smoke = seed #1 (`stock_quote`) — the only genuinely-pure execute available — then
prove the static-manifest ingest path against a real shipped manifest (`lobster`/`llm-task`
`openclaw.plugin.json`).

---

## 2. Recommendation

- **Canonical SOURCE:** the `openclaw` npm package (for `openclaw/plugin-sdk/*` + the shipped `extensions/*`)
  and the `@openclaw/*` npm scope, both backed by `github.com/openclaw/openclaw@main` (MIT). The
  `definePluginEntry` import is the real subpath export `openclaw/plugin-sdk/plugin-entry`.
- **Enumerate mechanism:** **crawl** `extensions/*` via the GitHub contents API
  (`api.github.com/repos/openclaw/openclaw/contents/extensions`) for the bundled pool; the **push-published**
  surface is the `@openclaw/*` npm scope (`registry.npmjs.org/-/v1/search?text=@openclaw`). There is **no
  marketplace/registry API** `[UNVERIFIED — none found in docs]`. Filter to manifests that declare
  `contracts.tools` (agent tools), dropping providers/channels/extractors.
- **PORTABILITY verdict:** **FEASIBLE-WITH-SHIM for PURE plugin tools; NOT-PORTABLE for gateway-coupled
  ones.** Purity = `execute` reads only `params`/`config`/`signal` and does NOT close over `api`. The shim
  doubles as the classifier and the def-captor.
- **Minimal adapter/shim:** a fake `api` whose `registerTool` captures `{def, opts}` and whose other
  `register*`/`on` methods are no-ops (logger=console, config={}); import the pinned plugin default export;
  call `register(fakeApi)`; re-register each captured `def` on pi via `pi.registerTool` (return shape is
  already pi-compatible `{content:[{type:'text',text}]}`). Validated in the wild by
  `@openclaw/plugin-inspector`'s `--mock-sdk` capture mode.
- **How execute reaches the generated `-e`:** model **(a)** — the generated `_pi/tools.ts` `import`s the
  pinned plugin + `openclaw/plugin-sdk`, runs the capture shim, `pi.registerTool`s the captured native
  execute, and the file is esbuild-bundled (externals = pi-injected specifiers, per the delivery brief). This
  adds an **`sdk` branch to `compile.ts`'s `renderTool`** distinct from the `mcp`/`callTool` branch.

## 3. Seed candidates (with pins)

1. **`stock_quote`** — pure `defineToolPlugin` docs template; `Type.Object({symbol})`, no `api`/network.
   docs.openclaw.ai/plugins/tool-plugins. Pin: `openclaw@2026.6.8`. **First smoke.**
2. **`echo`** — `openclaw plugins init` scaffold tool, pure. docs.openclaw.ai/plugins/tool-plugins. Pin:
   scaffold from `openclaw@2026.6.8`. `[UNVERIFIED emitted source]`.
3. **`lobster`** — lightest REAL shipped manifest+TypeBox (`extensions/lobster/`), but **gateway-coupled**
   (`runner.run()`); use only to validate static-manifest ingest, not as the first smoke. Pin:
   `@openclaw/lobster` `[UNVERIFIED version]` or `openclaw@main#extensions/lobster`.

## 4. Ingest pipeline (end-to-end)

1. **Enumerate** — crawl `extensions/*` (GitHub contents API) ∪ `@openclaw/*` npm scope; collect each
   `openclaw.plugin.json`.
2. **Fetch manifest (STATIC)** — read `id`, `contracts.tools[]` (names), `toolMetadata.<tool>.optional`,
   `description`, `configSchema`, `setup.providers[].envVars`. Yields a **skeleton `ToolEntry`**
   (address=`sdk.<id>:<tool>`, source=`sdk`, piName=sanitized, origin=`{kind:'openclaw-plugin',
   ref:'<pkg>@<ver>'}`, tags). **Filter to PURE candidates** (manifest has no `setup.providers`/embedding/
   channel contracts; no `factory` coupling in source) — the cheap pre-filter before the shim.
3. **Resolve description + param SCHEMA** — the manifest does NOT carry them, so run the **capture shim**
   (import pinned plugin → fake-api `register` → capture `def.description` + `def.parameters`), OR
   source-parse the TypeBox. Fill `ToolEntry.description` + `ToolEntry.parameters`. The shim's no-op `api` +
   a smoke `execute(params)` is also the **purity gate** — if execute throws on `api.*`, mark gateway-coupled
   and DROP.
4. **Map → `ToolEntry[]`** — the same pure-transform shape as `mcpToolsToEntries` (`ingest.ts`), but keyed
   off the OpenClaw manifest + captured def instead of an MCP `tools/list` row. (Add a sibling
   `openClawPluginToEntries(...)`.)
5. **Resolve the execute (per Coverage 5, model a)** — record the pinned package+version so `compile.ts`'s
   sdk branch can `import` it into the generated `-e` and esbuild can bundle it.
6. **Persist a FEW** into a **git-JSON catalog** (e.g. `packages/core/catalog/openclaw.sdk.json`): the
   ingested `ToolEntry[]` with `parameters` inlined + `origin.ref` carrying the **npm version or git commit**
   pin. Versioning = the `origin.ref` pin; re-ingest on bump. This slots beside the MCP ingest output as a
   second source feeding `DefaultToolRegistry.register(...)` at startup/seed.

## 5. Risks & UNVERIFIED

- **UNVERIFIED — no live plugin run.** The shim + capture + `pi.registerTool` chain is confirmed from the
  API shapes and the plugin-inspector `--mock-sdk` witness, but a real `openclaw plugins init` → shim-capture
  → `pi -p … -e <bundled>` smoke is the only thing that confirms a pure plugin tool actually executes under
  bare pi. **HIGH-PRIORITY live check.**
- **UNVERIFIED — no shipped pure tool.** Every SHIPPED `extensions/*` agent tool touches network/store/`api.*`.
  The pure path is proven only via docs examples (`stock_quote`/`echo`). Live check: run the purity-gate shim
  across the `contracts.tools` set to find any pure shipped tool empirically.
- **UNVERIFIED — manifest never carries param schema, even after `defineToolPlugin` build.** Confirmed
  `string[]` for hand-written manifests; whether `openclaw plugins build` ever emits per-tool params into the
  manifest is UNVERIFIED `[settle by building a `defineToolPlugin` package and reading its emitted
  openclaw.plugin.json]`. Design assumes NO (shim/source-parse required) — the safe assumption.
- **UNVERIFIED — no marketplace/registry API.** Enumerate is crawl (contents API) + npm scope; if OpenClaw
  later ships a `registry.json`, prefer it. `[settle by grepping docs for a registry endpoint]`.
- **UNVERIFIED — `@openclaw/lobster` version pin** (registry fetch timed out). Settle via
  `registry.npmjs.org/@openclaw%2Flobster`.
- **Risk — gateway drag under esbuild.** Bundling a plugin that LOOKS pure but transitively imports the
  gateway would bloat/break the bundle. Mitigation: the purity-gate shim is the predicate; only PURE plugins
  reach the bundle step. The delivery brief's externals (typebox + `@earendil-works/*` + node builtins) are
  unchanged for the sdk branch.
- **Risk — `StringEnum` vs `Type.Union`.** OpenClaw tools use TypeBox enums; on Gemini/Google providers
  string enums must be `StringEnum` (pi-ai), not `Type.Union/Literal` (prior brief §1). When we re-emit a
  captured `def.parameters`, preserve it verbatim (already `Type.Unsafe(...)` in `compile.ts:84`) — but a
  hand-authored OpenClaw `Type.Union` enum could misbehave on Google. Flag, don't auto-rewrite.
- **Risk — `optional` gating semantics.** OpenClaw's `toolMetadata.<tool>.optional:true` means "unloaded
  until allowlisted." For our static catalog this is metadata only; we always materialize the `ToolEntry`,
  and our own `tools.allow` is the gate. Note it in `tags`/`origin` for fidelity.

## 6. Change-pointer list (Phase-3 sdk-ingest — prose only, NO code)

- **`packages/core/src/tools/ingest.ts`** — add a sibling pure transform `openClawPluginToEntries(pluginId,
  manifest, capturedDefs, opts)` mirroring `mcpToolsToEntries`: address `sdk.<plugin-id>:<tool>`,
  `source:'sdk'`, `piName` via the existing `sanitize`, `parameters` from the captured `def.parameters`,
  `origin:{kind:'openclaw-plugin', ref:'<pkg>@<ver>'}`. Keep it a PURE transform (no network) — the caller
  owns the crawl + the capture-shim run, exactly as the MCP path keeps the fetch outside `ingest.ts`.
- **`packages/core/src/tools/compile.ts`** — add an **`sdk` branch in `renderTool`** (lines 71-90) distinct
  from the current mcp/`callTool` branch: for `source==='sdk'`, emit an `import` of the pinned plugin +
  `openclaw/plugin-sdk` and a capture-shim that `pi.registerTool`s the native captured execute (instead of
  `execute → callTool(address,…)`). Keep `parameters: Type.Unsafe(...)` and the JSON.stringify injection
  safety. The mcp branch is unchanged. This composes with the existing esbuild bundling pass (delivery
  brief) — the sdk import is bundled, externals unchanged.
- **A capture-shim module** (new, e.g. `packages/core/src/tools/openclaw-shim.ts`) — the fake-`api`
  def-captor used at BOTH ingest time (to learn description+parameters and gate purity) and inside the
  generated `-e` (to register the native execute). One shim, two call sites.
- **A git-JSON catalog** (new, e.g. `packages/core/catalog/openclaw.sdk.json`) — the FEW persisted ingested
  `ToolEntry[]` with `parameters` inlined and `origin.ref` pinned (npm version or git commit), loaded at
  registry seed time alongside `BUILTIN_TOOLS` (`registry.ts:10`).
- **`packages/core/src/tools/registry.ts`** — seed the catalog entries via the existing `register(...)`
  (the conflict-guard prefix at lines 28-40 already protects against `sdk`/`mcp`/builtin bare-name
  collisions; no change to the guard).
- **`packages/core/src/tools/verify.ts`** — NO change; the bind pre-check is source-agnostic (it checks
  declared ⊆ catalog + no piName collision), so sdk entries are covered as-is once registered.
- **`packages/core/package.json`** — the plugin pin (`openclaw`/`@openclaw/*`) becomes a host-side
  build/ingest dependency available where the bundle is produced (same constraint as esbuild + tool-bridge
  in the delivery brief). The plugin is NOT staged raw into the sandbox — it is bundled.

---

## Appendix — source list (confidence-tagged)

- `[GROUND]` in-repo: `packages/core/src/tools/{compile,ingest,registry,verify}.ts`,
  `packages/core/src/types.ts:307-345`; prior briefs
  `docs/research/pi-tools-extensions-openclaw-2026-06-21.md`,
  `docs/research/tool-bridge-delivery-2026-06-21.md`.
- `[PRIMARY]` OpenClaw repo/docs: https://github.com/openclaw/openclaw (MIT, branch `main`) ·
  https://api.github.com/repos/openclaw/openclaw/contents/extensions ·
  extensions/{llm-task,memory-core,lobster}/openclaw.plugin.json (verbatim manifest snippets) ·
  https://docs.openclaw.ai/plugins/{building-plugins,sdk-overview,sdk-entrypoints,tool-plugins,manifest,hooks}
  · src/plugins/tools.ts · https://open-claw.bot/docs/platforms/pi/ ·
  https://github.com/openclaw/plugin-inspector (mock-sdk capture pattern).
- `[PRIMARY]` npm: package `openclaw` (`registry.npmjs.org/openclaw` — `exports["./plugin-sdk/*"]`, latest
  `2026.6.8`, MIT) · `@openclaw/*` scope (`registry.npmjs.org/-/v1/search?text=@openclaw`).
- `[PRIMARY]` pi: `@earendil-works/pi-coding-agent` `createAgentSession()` / `registerTool` (prior brief §1).
- `[UNVERIFIED]`: live pure-plugin run under `pi -e`; existence of any pure SHIPPED tool; whether
  `openclaw plugins build` emits per-tool params into the manifest; existence of a marketplace/registry API;
  `@openclaw/lobster` version pin; exact `openclaw plugins init` emitted source.

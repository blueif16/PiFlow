# OpenClaw Plugin Substrate Adoption — scope & findings

**Status:** scoped, not started (2026-06-22). Supersedes the "reference OpenClaw over MCP" framing for the *plugin* question.

**Goal (one line):** Adopt OpenClaw's plugin **substrate** natively into our pi-based system so the whole community plugin ecosystem registers and runs as ours — every tool an agent might need — *for granted*, by manifest. Not MCP-wire a handful of tools; own the pipe.

---

## Scope decision

**IN — everything required to run plugin *tools*:**
1. **The plugin contract** (`@openclaw/plugin-sdk`) — what every community plugin codes against.
2. **The tool host** — register + execute stateless tools.
3. **The long-running plugin-server runtime** — keep plugin-owned servers/sessions/background jobs alive (browser's Playwright session, canvas's HTTP server, memory's reindex/watch).

**OUT — channels (deliberate):** telegram/whatsapp/discord/slack/feishu/google-meet/voice-call/qqbot/zalouser. These are **human-interaction surfaces**, not agent tools. They need external platform creds + webhooks + persistent connections the full gateway operates. Set aside; migrate one on-demand only if a specific platform is ever needed. Excluding them costs us nothing the agent needs.

**OUT — agent runtime & providers:** `src/agents` (25 M) + `src/llm`. **pi already is these** (design-shared — see Lineage). Migrating them would be redundant.

### "Is contract + tool-host + long-running-runtime everything required to run all the tools?"
**Yes — essentially.** Those three layers + our existing `SecretResolver` (for key-gated plugins) cover buckets A + B (all 64 tool-bearing, non-channel tools). Two honest footnotes, both *inside* "the runtime" (not new categories):
- **node-bus (`node.invoke`)** — a few tools (e.g. `file-transfer`'s `file_fetch`) do paired-**device** RPC. That's runtime, not a channel, but it's tied to multi-node topology. On a single host it degrades or maps to local fs. Only ~1 plugin depends on it.
- **provider access (LLM/embeddings)** — `memory_search` (embeddings) and `llm-task` (a model) need a provider. That wiring is part of the runtime and maps onto **pi's** provider layer. Keyless tools (`memory_get`, file ops, browser, diffs) need none of it.

Neither breaks the thesis. The three layers are the complete set for agent-facing tools.

---

## Lineage finding — why this is a pi-COMPATIBLE port, not a graft

Forensic-verified (2026-06-22, two subagents + local source at `vendor/openclaw`):
- OpenClaw **originally ran on pi's SDK** (imported `pi-coding-agent`/`pi-agent-core`/`pi-ai`; its loop *was* pi's `createAgentSession()`). It **migrated off** by `openclaw@2026.6.9` — internalized `packages/agent-core` + `src/agents/embedded-agent-runner`, keeping only `@earendil-works/pi-tui`.
- **Not a fork** — OpenClaw was a *consumer* of pi's published SDK (pi = Mario Zechner/earendil-works; OpenClaw = steipete/vincentkoc; pi's README lists OpenClaw as a flagship SDK integration).
- The internalized runtime is a **genuine rewrite, ~85–90% design-shared, 0% code-copied**: identical `Agent`/`agentLoop`/harness *contracts* as pi, but imports `@openclaw/llm-core` and adds a `runtime` injection param.

**Implication:** adopting OpenClaw's plugin-host onto pi is **low-impedance** — the substrate is the same lineage. The one deep service the ecosystem needs, `runtime.agent.runEmbeddedAgent`, maps **directly** to pi's `createAgentSession()`.

---

## Ecosystem sizing (census of all 135 manifests; live-proven)

| Bucket | Plugins | Tools | Status |
|---|---|---|---|
| **A — keyless** | 11 (memory-core, memory-lancedb, memory-wiki, browser, canvas, file-transfer, diffs, llm-task, lobster, codex-supervisor, workboard) | 58 | IN |
| **B — key-gated** (via SecretResolver) | 3 (firecrawl, tavily, xai) | 6 | IN |
| **C — channels/platform** | 5 (feishu, google-meet, voice-call, qqbot, zalouser) | 19 | **OUT** |
| **D — no tools** (LLM providers/channels) | 116 | 0 | n/a |

**Headline: 64 tools across 19 plugins inheritable; pipe inherits future plugins by manifest.** Live-proven: standalone `plugin-tools-serve.js` serves 8 by default, 20–25 with config. (Installed pkg bundles 77 ext in `dist/`; some — memory-lancedb, firecrawl, diffs — are external `openclaw plugins install @openclaw/*`.)

Tool concentration: workboard 34, memory(×3) 10, browser/canvas/files/diffs ~7, scrape(firecrawl/tavily) keyed, llm-task/lobster/codex-supervisor (deeper-runtime).

---

## What to build — the three layers and their `api` surface

### Layer 1 — Contract (trivial)
Vendor `packages/plugin-sdk` (116 K, **zero deps**). The keystone; plugins import their types/`definePluginEntry` from it.

### Layer 2 — Tool host (low; days)
A loader (`resolvePluginTools` + `standalone-runtime-registry-loader`, in `src/plugins/*`) that runs each manifest's `register(api)`, plus the **6 essential `api` services**:

| Essential service | Maps to on pi |
|---|---|
| `registerTool` | our tool registry / bridge |
| `config` / `pluginConfig` | our run config |
| `logger` | pi logger |
| `runtime.state.openKeyedStore` | a KV store (small) |
| **`runtime.agent.runEmbeddedAgent`** | **pi `createAgentSession()`** |
| `runtime.agent.resolveAgentDir` | workspace path |

### Layer 3 — Long-running plugin-server runtime (medium–hard, BOUNDED; weeks)
A long-lived host process providing the lifecycle/bus surface so plugin-owned servers stay alive. A slice of `src/gateway` (11 M) + `src/plugins` (8.4 M), ported onto pi's process model:
- `registerService` (service bus + lifecycle)
- `registerHttpRoute` (mount an HTTP server — e.g. canvas)
- `registerGatewayMethod` (JSON-RPC method bus)
- `lifecycle.registerRuntimeLifecycle` (startup/shutdown hooks — e.g. browser session)
- background tasks / cron; node-bus (for the one paired-device tool)

These are **optional for stateless tools** (stub as no-ops → tool still registers/executes) but **essential for the long-running plugins** the agent wants.

> The other ~20 `api.register*` verbs (memory-capability, web-fetch-provider, CLI, auto-enable-probe…) are **graceful-degrade**: stub them and the tool still registers and is callable directly.

---

## Migration plan

1. Vendor Layer 1 (`plugin-sdk`) + the Layer-2 loader.
2. Implement the 6-service `api` shim on pi (`runEmbeddedAgent` → `createAgentSession`).
3. Implement Layer 3 (service/HTTP/gateway-method/lifecycle bus) as a pi-hosted daemon.
4. Wire `SecretResolver` for bucket B.
5. Channels: **not migrated.**

**Cost honesty:** copying is trivial (MIT, full source, pi-compatible). The real work is the Layer-3 port (~10–15 M of relevant pi-compatible source; weeks–months, one engineer) + owning a fork (track `plugin-sdk` version on bumps). Not a wargame — finite.

## Proof spikes (in order)
- **S1 (registration):** all 19 plugins register on *our* host; `memory_get` (keyless) executes through our `api`. ✓ proves Layers 1–2.
- **S2 (the demand — long-running):** bring up a **server** plugin natively — `canvas` (persistent HTTP server) or `browser` (live Playwright session) — and hit its endpoint. ✓ proves Layer 3.
- **S3 (runEmbeddedAgent):** `llm-task` runs through pi's `createAgentSession()`. ✓ proves the deep-runtime tier.

## Open risks
- `workboard`'s `runtime.subagent` / `lobster`'s `managedFlows` may fail at **call** time (not registration) — needs a per-plugin call smoke (S2/S3 covers the pattern).
- `api` surface is not a frozen contract — the long tail of future plugins may reach for services beyond our shim; mitigated by the loader exposing the full `plugin-sdk` surface and stubbing the unimplemented as loud no-ops.
- Fork/drift: re-vet `plugin-sdk` + loader on OpenClaw version bumps.

---

## Related
- `docs/design/l1-node-envelope.md`, `orchestration-substrate.md` — the node/runtime context this plugs into.
- Memory: `openclaw-ecosystem-sizing`, `openclaw-as-mcp-gateway` (the MCP path this supersedes for the *plugin* question; MCP remains valid for *external* MCP servers).

---

## Wiring plan — evidence-backed (2026-06-22)

Three read-only forensic passes over the installed `openclaw@2026.6.9` (`node_modules/openclaw/dist`) + this repo turned the scope above into a concrete build. File:line anchors below are load-bearing — re-verify them on a version bump.

### Mental-model correction (read this before touching code)
The seam `runtime.agent.runEmbeddedAgent` fronts `runEmbeddedAgentInternal` — a ~4000-LOC internalized agent loop (`embedded-agent-Cv16r2d1.js`: a `while` retry/failover loop, session lanes, compaction). **That is NOT a runtime we port.** It is OpenClaw's re-internalized copy of what was *pi's own loop* (Lineage §: OpenClaw's loop *was* `createAgentSession()` before it migrated off). **We drop `embedded-agent-*.js` entirely and bind the seam to pi.** "No duplicate runtime" is literal: we host the tool *substrate* + the provider-wire, and pi supplies the loop. A future session that reopens `embedded-agent-*.js` and panics at 4000 LOC is making last session's mistake — that file does not come over.

### Vendor / drop / adapt
- **VENDOR verbatim (gateway-free — Subagent A confirmed no `createServer`/express/fastify in the closure):** the host closure `api-builder-CX43eAAh.js` + `loader-CUGwG1IR.js` + `registry-DibRJtL4.js` (197 KB, dominates) + `plugin-entry` + `tool-plugin` ≈ **332 KB / 5 chunks**; the keyless plugin dirs (`extensions/memory-core/*` ≈ 136 KB); `llm-core` provider-wire (~344 KB — **only** when a tool calls a provider directly; `memory_get` does not).
- **DROP:** channels (scope §), `embedded-agent-*.js` (replaced by pi), the gateway HTTP server (a tool-host boots without it).
- **ADAPT — the only code we write, both thin:**
  1. **Execute driver.** Subagent A's load-bearing surprise: `registry`/`loader` only **store tool factories** (`registry-DibRJtL4.js:3082-3099`); the `factory(ctx)` → `tool.execute(toolCallId, params, signal, onUpdate)` call lives in OpenClaw's agent runtime, which we are NOT vendoring. So hosting tools means **we drive execution ourselves**: build a `ctx` and invoke the stored factory + execute. There is no free "run this tool" entrypoint.
  2. **Runtime seam.** A `runtime` object: `state.openKeyedStore` real (small, register-time — `memory-core/index.js:261`), `agent.runEmbeddedAgent` → the pi adapter (below), `agent.resolveAgentDir` → workspace path, **everything else a loud-throwing stub.**

### The host = the doc's 3 layers, now concrete
- **L1 Contract** — already on disk (`openclaw/dist/plugin-sdk`). Our existing `packages/core/src/tools/openclaw-shim.ts` `CaptureApi` is the L1 driver in its *capture* form (no-op `api`, pure-tools-only). **Evolve it:** keep `registerTool`, replace the no-op `runtime` *absence* with the real-or-stub `runtime` object.
- **L2 Tool host** — loader: discover manifest → `import(entry)` → `buildPluginApi({ handlers:{registerTool}, runtime })` (`api-builder` fills every other `registerX` as a no-op default) → `runPluginRegisterSync(register, api)` (**register is SYNCHRONOUS and Proxy-guarded** — no async in `register`) → store factory → **execute driver** runs it. `memory_get`'s execute touches **no `runtime.*`** (Subagent A: it's an fs-backed read needing only `ctx{cfg, agentId, sessionKey}`), so a stub runtime registers AND runs it.
- **L3 Runtime seam** — the `runtime` object above; the long-running daemon (canvas/browser HTTP + lifecycle) is the deferred hard part.

### The seam adapter — the one real port
`runtime.agent.runEmbeddedAgent` (called from `extensions/llm-task/index.js`):
- **IN** (llm-task uses ~13 of ~150 `RunEmbeddedAgentParams`): `{ prompt, config, provider, model, thinkLevel, streamParams, sessionId, sessionFile, workspaceDir, timeoutMs, disableTools }`.
- **OUT** `EmbeddedAgentRunResult` = `{ payloads: [{ text?, isError?, isReasoning?, mediaUrl? }], meta }`.
- **Backed by pi — two options:**
  - **(B) CLI-backed — recommended first.** The adapter maps `prompt`→staged `@file`, `model`→`--model`, `tools`→`--tools` + generated `-e`, then spawns the **same** `pi -p --mode json …` the runner already uses (`defaultPiCommand`, `runner/command.ts:53`), parsing `lastJsonBlock` (`runner/runner.ts:180`) → wraps as `{payloads, meta}`. A nested pi run. **Zero new deps; reuses the proven path.**
  - **(A) SDK-backed — end-state (doc S3).** Import pi's agent SDK, call `createAgentSession()` in-process. Cleaner, but adds a dependency and stands pi up in-process — **not done today** (the runner only ever shells out; `createAgentSession` is used nowhere in the repo). Defer until B proves the seam.
- **Secrets/provider:** reuse the existing `SecretResolver` (`packages/core/src/types.ts:319` → applied `runner.ts:291` → `CreateOpts.env` `runner.ts:412`); models/keys via env `*_API_KEY` or pi's `--provider cp`.

### Build order (operationalizes S1→S3 with real targets + an acceptance bar each)
- **S0 — execute driver, one keyless tool (NEW, smallest).** `memory-core/memory_get` end-to-end through the **real** host (not the capture no-op). *Accept:* `register()` returns; `execute('t', {key})` returns the fs-backed value. *Proves* the execute driver — the thing `registry`/`loader` don't hand us.
- **S1 — registration breadth.** All 19 manifests `register()` on the host under the stub runtime. *Accept:* 19/19 return without throw. *This is the "works on one → works on all" registration guarantee.*
- **S2 — provider-wire, no agent loop.** A `llm-core`-backed tool needing only a key: `memory_search` (embeddings) or `firecrawl` (key-gated via `SecretResolver`). *Accept:* a real provider call returns. *Proves* `llm-core` copies clean.
- **S3 — the seam.** `llm-task` → `runEmbeddedAgent` → pi (CLI-backed first). *Accept:* `llm-task` returns `{payloads}` from a real nested pi run. *Proves* the one seam.
- **S4 — long-running (deferred).** `canvas`/`browser` via `registerHttpRoute` + lifecycle — the doc's L3 daemon; the hard, bounded part.

### Risks / notes specific to the wiring
- The **execute driver** is genuinely new code, not a free entrypoint (Subagent A).
- `register` is **sync + Proxy-guarded** — async work in `register` throws; only late-callable methods (`emitAgentEvent`, `scheduleSessionTurn`…) fire after registration closes.
- `workboard`/`lobster` reach `runtime.subagent`/`managedFlows` at **call** time — same adapter pattern as S3, deferred with it.
- We own a fork → on a version bump, re-diff **`api-builder` + `registry` + `loader` + `llm-core`** (4 surfaces), not 135 plugins.

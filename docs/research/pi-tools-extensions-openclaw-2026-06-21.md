# pi tools / extensions / MCP + OpenClaw layering — research brief (2026-06-21)

Research input for designing **Pi Flow's** declarative per-node tool wiring (`namespace:name`). Goal:
map a clean SDK tool model onto how `pi` natively handles tools/extensions/MCP, mirroring how **OpenClaw**
extends pi — but as an SDK, not a gateway.

**Confidence legend:** `[GROUND]` = our in-repo reference files (authoritative for what we run today) ·
`[PRIMARY]` = pi/OpenClaw/MCP official docs or source · `[SECONDARY]` = third-party write-up / community
extension · `[UNVERIFIED]` = could not confirm from a primary source.

**Scope fence:** this brief is about TOOL wiring only. The sandbox / filesystem-scope side is owned by another
agent and is out of scope here (we only note where pi's `--sandbox` / OpenClaw's sandbox layer *removes* a
tool, because that intersects tool resolution).

---

## 0. Ground truth (what we run today) — do not re-derive

From `reference/cli.md`, `reference/orchestration.md`, `docs/pi-agent-notes.md`,
`templates/legacy/providers/coding-plan.ts`, `templates/pi-runner/extensions/node-contract.ts`: `[GROUND]`

- pi built-ins we assume: `read bash edit write grep find ls`.
- Headless invocation: `pi -p --mode json -a --no-session --offline --no-extensions --provider cp @<prompt-file>`.
- Per-node tool wiring **already exists in our harness** via DRIVER markers that the driver compiles to
  `pi --tools <allowlist>` / `--exclude-tools`. Per-node ownership/contract enforced by the `-e`
  `node-contract.ts` extension (`PI_NODE_OWNS`, `PI_NODE_REQUIRE`, typed `submit_result`).
- Provider registered via a `-e` extension (`coding-plan.ts` → `pi.registerProvider("cp", {...})`).
- Credentials/model live once in `~/.pi/agent/models.json`.

So **two of the three "tool sources" in our target model already touch real pi mechanism**: SDK-defined
tools = the `node-contract`-style `-e` extension that calls `registerTool`; the allow/deny list = `--tools` /
`--exclude-tools`. The new work is a *registry + resolver* on top, plus the MCP bridge.

---

## 1. pi EXTENSIONS / `registerTool` — exact API `[PRIMARY]`

Sources: pi docs `pi.dev/docs/latest/extensions`; repo `packages/coding-agent/docs/extensions.md` and
`docs/sdk.md`; our own `node-contract.ts` (which compiles and runs, so it is a live witness of the API).

### Extension factory + locations
- An extension is a module that **default-exports a factory** `(pi: ExtensionAPI) => void | Promise<void>`.
  Async factories are awaited before `session_start` / provider flush.
- Auto-discovered locations (`[PRIMARY]`, pi.dev extensions doc):
  - `~/.pi/agent/extensions/*.ts` and `~/.pi/agent/extensions/*/index.ts` (global)
  - `.pi/extensions/*.ts` and `.pi/extensions/*/index.ts` (project-local)
  - or shipped inside a pi package.
- Loaded via **jiti** → TypeScript runs **without a compile step**. Hot reload with **`/reload`** for
  auto-discovered locations.
- `--no-extensions` disables auto-discovery, **but an explicit `-e <path>` still loads** `[GROUND]` +
  `[PRIMARY]` (this is exactly how our `coding-plan.ts` and `node-contract.ts` load under our headless flags).
- The loader **bundles `typebox` and `@earendil-works/pi-coding-agent`**, so an extension file outside pi's
  `node_modules` can still import them `[GROUND]` (resolution note in `node-contract.ts:47-49`).

### `registerTool` field names (exact) `[PRIMARY]`
```ts
pi.registerTool({
  name: string,                 // tool id the model calls (e.g. "submit_result")
  label: string,                // human label
  description: string,          // model-facing description
  parameters: Type.Object({…}), // TypeBox schema  (import { Type } from "typebox")
  promptSnippet?: string,       // one line appended to the system prompt
  promptGuidelines?: string[],  // bullets appended FLAT to Guidelines — each MUST name its own tool
  prepareArguments?(args): unknown,   // runs BEFORE schema validation (old-session arg shims)
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: "…" }], details?: {…}, terminate?: boolean };
  },
  renderCall?, renderResult?, renderShell?   // optional TUI rendering
});
```
- **`parameters` is a TypeBox schema** (`Type.Object(...)`). CAVEAT `[PRIMARY]`: for string enums use
  **`StringEnum` from `@earendil-works/pi-ai`** — `Type.Union`/`Type.Literal` "doesn't work with Google's
  API." (Our `node-contract.ts` uses `Type.Union(Type.Literal(...))` for `status`; fine for OpenAI-compatible
  `cp` providers, would break on Gemini.)
- **`execute` arg order:** `(toolCallId, params, signal, onUpdate, ctx)`. Return `{ content[], details?,
  terminate? }`. `terminate:true` skips the follow-up LLM turn (we rely on this for `submit_result`)
  `[GROUND]`.
- The structured `details` reach a `-p` driver on the **`tool_execution_end`** JSON event `[GROUND]`.

### Other `ExtensionAPI` methods `[PRIMARY]`
`pi.registerTool` · `pi.registerCommand(name,…)` · `pi.registerShortcut(combo,…)` · `pi.registerFlag(name,…)`
· `pi.registerProvider(name, config)` · `pi.on(event, handler)` · `pi.sendUserMessage(content, opts?)` ·
`pi.appendEntry(type, data?)`.

### Hook form — `pi.on("tool_call", …)` `[PRIMARY]`+`[GROUND]`
```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input (mutable)
  return { block: true, reason: "…" };   // or undefined to allow
});
```
- Return `{ block:true, reason }` to veto a call (our owns-block + write-first gate use exactly this).
- `isToolCallEventType("bash", event)` narrows the event type for typed access to `event.input` `[PRIMARY]`.
- `agent_end` hook + `sendUserMessage(..., { deliverAs:"followUp" })` re-prompts before the run ends
  `[GROUND]`.

### Programmatic SDK form `[PRIMARY]` (`packages/coding-agent/docs/sdk.md`)
```ts
import { createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const myTool = defineTool({ name, label, description, parameters: Type.Object({…}),
  async execute(toolCallId, params) { return { content:[{type:"text",text:"…"}], details:{} }; }});

const { session } = await createAgentSession({
  model?, thinkingLevel?,
  tools?: string[],          // ALLOWLIST of tool names (built-in + extension + custom)
  customTools?: ToolDefinition[],   // inline tools (defineTool output)
  excludeTools?: string[],   // disable specific names (applied after allowlist)
  resourceLoader?, sessionManager?, cwd?, agentDir?, …
});
```
- **`defineTool` has the same field set as `registerTool`** (our `node-contract.ts` already imports
  `defineTool` from `@earendil-works/pi-coding-agent`) `[GROUND]`.
- IMPORTANT `[PRIMARY]`: "If you pass `tools`, include each custom or extension tool name you want enabled."
  i.e. the allowlist is authoritative — a custom tool not named in `tools` is invisible.
- There is **no documented `beforeToolCall` callback option on `createAgentSession`** `[PRIMARY]`; the
  gating hook is the extension-side `pi.on("tool_call", …)`. Programmatic consumers observe execution via
  `session.subscribe(event => …)` (`tool_execution_start/update/end`). `[UNVERIFIED]` whether a
  programmatic pre-call veto exists outside an extension.

---

## 2. pi TOOL SELECTION — flag semantics `[PRIMARY]` (repo README) + `[GROUND]`

| Flag | Exact meaning (README) |
|---|---|
| `--tools <list>` | "Allowlist specific tool names across built-in, extension, and custom tools." |
| `--exclude-tools <list>` | "Disable specific tool names across built-in, extension, and custom tools." |
| `--no-builtin-tools` (alias `-nbt`) | "Disable built-in tools by default but keep extension/custom tools enabled." |
| `--no-extensions` | "Disable extension discovery." (explicit `-e` still loads `[GROUND]`) |
| `-e, --extension <source>` | "Load extension from path, npm, or git (repeatable)." |

Composition (all `[PRIMARY]`):
- **`--tools` allowlists across all three sources at once** (built-in ∪ extension ∪ custom) — one flat
  namespace of tool *names*. There is no per-source qualifier in the flag.
- `--exclude-tools` is applied as a denylist over whatever survived.
- `--no-extensions` removes the *discovery* of auto-loaded extension tools, but `-e <file>` re-adds an
  explicit one — so a generated `-e` extension's tools ARE eligible for the `--tools` allowlist even under
  `--no-extensions`. **This is the exact seam Pi Flow compiles into.**
- `--no-builtin-tools` lets us ship a node that runs *only* SDK/extension tools (no `bash`/`write`) — useful
  for a pure "web:search → write summary" node.
- Programmatic equivalents: `createAgentSession({ tools, excludeTools, noTools:"all"|"builtin" })` `[PRIMARY]`.

**Key consequence for our design:** pi's selection surface is a **single flat allowlist of bare tool
names**. Any `namespace:name` convention we adopt is **our** abstraction; it must *compile down* to bare
names pi recognizes (the registry owns the namespace→name mapping). pi never sees the colon.

---

## 3. pi MCP — does pi bridge MCP servers? `[PRIMARY]`

**pi's core deliberately does NOT support MCP.** README, verbatim: **"No MCP. Build CLI tools with READMEs
(see Skills), or build an extension that adds MCP support."** Author's rationale `[PRIMARY]`/`[SECONDARY]`
(mariozechner.at): MCP servers "dump their entire tool descriptions into your context on every session"
(Playwright MCP = 21 tools / 13.7k tokens; Chrome DevTools MCP = 26 tools / 18k tokens → "7–9% of your
context window gone before you even start"). Recommended alternative: **CLI tools with README files**
(progressive disclosure: the agent reads the README and invokes via `bash` only when needed;
`github.com/badlogic/agent-tools`), or `mcporter` to wrap an MCP server as a CLI.

So **MCP-as-callable-tools is NOT native** — it is an *extension* concern. Community bridge:
**`pi-mcp-adapter`** (`github.com/nicobailon/pi-mcp-adapter`) `[SECONDARY]`:
- Default = **one `mcp` proxy tool** (~200 tokens) instead of dumping every MCP tool; the model
  searches/lists/describes on demand. Servers connect lazily.
- **Naming when promoted (`directTools`)** — a configurable `toolPrefix`:
  - `"server"` (default): `<server>_<tool>` with **underscore** delimiter, e.g. `chrome_devtools_take_screenshot`.
  - `"short"`: strips a trailing `-mcp` from the server name.
  - `"none"`: original MCP tool name, no prefix.
- Config keys: per-server `command/args/env/url/headers/auth/oauth`, `lifecycle: lazy|eager|keep-alive`,
  `idleTimeout`, `directTools: true|string[]|false`, `excludeTools: string[]`, `exposeResources`; global
  `toolPrefix`, `disableProxyTool`, `autoAuth`. Tool names are fuzzy-matched on `-`/`_`.

**Takeaway for our design:** when an MCP tool IS surfaced to the model, the de-facto pi-ecosystem name is
**`<server>_<tool>` (underscore-joined, flat)** — there is no native dot/colon namespacing inside pi. Our
`mcp.<server>:<tool>` is again an *SDK-level* address that must compile to this flat underscore name (or to
the proxy tool's argument).

---

## 4. OpenClaw layering over pi `[PRIMARY]` — **with a correction**

> **CORRECTION to the GO brief's caveat.** The GO prompt said OpenClaw's core runtime is "reported
> CLOSED-SOURCE." Multiple primary/secondary sources say the **opposite**: OpenClaw is **MIT-licensed and
> fully open source** — gateway, agents, plugins, and SDK all live in `github.com/openclaw/openclaw`
> (TypeScript/Node). I could **not** find support for the closed-core claim. Treating it as OPEN below; if
> the team has a specific source for the closed-core claim, re-verify, but the public signal is open.
> `[PRIMARY]` docs.openclaw.ai/plugins/architecture, /plugins/sdk-overview.

OpenClaw **embeds pi** as its agent runtime: it does **not** spawn `pi` as a subprocess — it imports and
instantiates pi's `createAgentSession()` directly inside its Gateway, injecting messaging/sandbox/channel
tools as custom tools `[PRIMARY]` (open-claw.bot/docs/platforms/pi). This is the single most relevant fact
for us: **OpenClaw is a worked example of the programmatic SDK form in §1 — a host that owns the pi session
and feeds it a curated tool set per agent.** Our SDK occupies the same role, except we drive pi as a
*headless child process* (the `pi-runner` model) rather than an in-process import.

### Plugin API (`[PRIMARY]`, docs.openclaw.ai/plugins/building-plugins)
```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
export default definePluginEntry({
  id: "my-plugin", name: "My Plugin",
  register(api) {
    api.registerTool(
      { name: "my_tool", description: "…", parameters: Type.Object({ input: Type.String() }),
        async execute(_id, params) { return { content:[{type:"text",text:`Got: ${params.input}`}] }; } },
      { optional: true });          // 2nd arg gates exposure
    api.registerProvider({ … });
    api.registerChannel({ … });
    api.registerEmbeddingProvider({ … });
  }
});
```
- Entry helpers: `definePluginEntry` (non-channel) · `defineChannelPluginEntry` (channel; auto-calls
  `registerChannel`) · `defineToolPlugin` (tool-only; infers config + param types from TypeBox).
- **`registerTool` field set mirrors pi's** (`name, description, parameters: TypeBox, execute(_id,params)`
  → `{content:[…]}`) — unsurprising, since the tools flow into the embedded pi session.
- **Manifest requirement** `[PRIMARY]`: every registered tool MUST also be declared under
  `contracts.tools: [...]`, with optional `toolMetadata.<tool>.optional`. `optional:true` keeps the plugin
  runtime unloaded until the tool is allowlisted.

### Per-agent tool PROFILES / allow-deny `[PRIMARY]` (docs.openclaw.ai/tools, /gateway/config-tools)
- Config keys **`tools.allow`** / **`tools.deny`** (allow/deny by tool name *or* by `["plugin-id"]` to take
  all of a plugin's tools).
- **Enforced BEFORE the model call:** "If policy removes a tool, the model does not receive that tool's
  schema for the turn." A tool must survive *every* layer to be sent.
- Layers that can remove a tool: **global config · per-agent config · channel policy · provider
  restrictions · sandbox rules · plugin availability.** (Per-agent + sandbox restrictions documented at
  `/tools/multi-agent-sandbox-tools` — exact per-agent keys not fully quoted in fetched pages `[UNVERIFIED]`.)
- **Naming/namespacing:** "Tool names must not conflict with core tools; conflicts are skipped and reported
  in plugin diagnostics." **No prefix convention is mandated** — OpenClaw uses a **flat tool-name space**
  with a conflict-skip rule, same shape as pi's. `[PRIMARY]`
- Known open bugs `[SECONDARY]` (issues #47683, #61790): plugin `registerTool` tools sometimes land in the
  plugin registry but are not surfaced to the embedded pi runtime; the `before_tool_call`/`api.on(...)` hook
  is reported as a working enforcement path. Flagging because it shows the registry→runtime handoff is the
  fragile seam — the exact seam our resolver owns.

**Net:** OpenClaw does **not** give us a richer *namespacing* convention to copy — it too is flat-name +
allow/deny + pre-model filtering. What it validates is the **architecture**: a host curates a per-agent tool
set and feeds the (embedded) pi session. We replicate that as compile-to-flags over a headless pi.

---

## 5. NAMING CONVENTIONS across the ecosystem `[PRIMARY]`

| System | How a tool is addressed | Delimiter | Namespaced? |
|---|---|---|---|
| **pi built-ins/extensions** | flat bare name (`read`, `bash`, `submit_result`) | — | No — single flat allowlist |
| **pi MCP via adapter** | `<server>_<tool>` (or proxy tool) | `_` underscore | Prefix-as-name, still flat |
| **OpenClaw plugin tools** | flat bare name; conflicts skipped | — | No — flat + conflict rule |
| **MCP spec** | `name` = "unique identifier"; SEP-986 *proposes* `/` and `.` for hierarchy | historically `_` (`github_get_issue`); proposal allows `. /` | Per-spec: unique **within a namespace**; client-side prefixing common |
| **n8n** | `nodeType` = `packageName.nodeName` (`n8n-nodes-base.httpRequest`); ops = resource+operation | `.` dot for package, then resource/operation fields | Yes — package-dotted node types |

Findings:
- **MCP** `[PRIMARY]` (modelcontextprotocol.io/specification/2025-11-25; SEP-986 issue #986): tool `name`
  is a unique identifier; the spec historically prescribed **no** format, so clients converged on
  **underscore prefixing** (`github_get_issue`). **SEP-986** proposes a formal charset `[a-zA-Z0-9_.-/]` and
  explicitly allows **`.` and `/` for hierarchical/namespaced names**, with the rule "**unique within their
  namespace**." Status: **proposal under discussion**, not ratified — so `.`/`/` are *forward-compatible*
  but `_`-prefixing is the safe wire format today.
- **n8n** `[PRIMARY]`: node *types* are **dot-namespaced by package** (`@n8n/n8n-nodes-langchain.agent`),
  and within a node the **resource + operation** pattern (`action` combines them). This is the closest
  ecosystem precedent for a real `namespace.name` (well, `package.node`) addressing scheme.

**Convention choice rationale (for §6):** A **colon** `namespace:name` is the right SDK-facing address:
- It does **not collide** with any wire format — pi/OpenClaw use bare names, the MCP adapter uses `_`, n8n
  uses `.`. Colon is unused by all of them, so our address never gets confused with a real tool name.
- It is the same idiom as MCP client UIs and `docker`/`k8s` (`namespace:resource`) and reads naturally for
  the three sources: `fs:read`, `web:search`, `mcp.github:create_issue` (dotted *server* sub-namespace under
  the `mcp` root, colon before the tool — matching MCP's own `server` + `tool` split).
- It is **purely an SDK abstraction**: the registry resolves `namespace:name` → a bare pi tool name + a
  source. pi never sees the colon (see mapping table §6).

---

## 6. SYNTHESIS — proposed declarative tool model for Pi Flow

### 6.1 `ToolRegistry` keyed by `namespace:name`
A single registry is the one place every tool — from all three sources — is addressed:
```ts
type ToolAddress = `${string}:${string}`;            // e.g. "fs:read", "web:search", "mcp.github:create_issue"
interface ToolEntry {
  address: ToolAddress;
  source: "builtin" | "sdk" | "mcp";
  piName: string;          // the BARE name pi will actually see in --tools / customTools
  // builtin: piName === the native name (fs:read → "read")
  // sdk:     piName === the registerTool name compiled into the generated -e extension
  // mcp:     piName === "<server>_<tool>" (adapter directTools) OR routed through the proxy tool
  define?: () => PiToolDefinition;   // for source==="sdk": the defineTool/registerTool body
  mcpServer?: McpServerConfig;       // for source==="mcp": connection + lifecycle
}
```
- **Namespace roots** are conventions, not pi mechanism: `fs:` → built-ins (`fs:read→read`, `fs:write→write`,
  `fs:bash→bash`, …); `web:`, `git:`, etc. → SDK tools; `mcp.<server>:` → MCP. The registry owns the
  `address → {piName, source}` table — this is the **new SDK layer**.

### 6.2 How a node DECLARES its toolset (in its contract)
The node contract carries allow/deny lists **in `namespace:name` addresses**:
```ts
tools: {
  allow: ["fs:read", "fs:write", "web:search", "mcp.github:create_issue"],
  deny:  ["fs:bash"],          // optional denylist over the allow set
}
```
The Pi Flow compiler resolves each address through the registry and emits pi's existing flags + a generated
extension. **`allow` → `--tools <piNames>`; `deny` → `--exclude-tools <piNames>`.** A node that lists no
built-in `fs:*` tool compiles with `--no-builtin-tools` (so `--tools` need only name the extras).

### 6.3 The three sources → how each RESOLVES to pi

| Tool source | Declared as | Compiles to pi via | Maps onto EXISTING pi mechanism? |
|---|---|---|---|
| **(i) Built-in** | `fs:read`, `fs:bash`, … | name in `--tools` allowlist (and/or `--no-builtin-tools` + re-add) | **YES, fully** — `--tools`/`--exclude-tools`/`--no-builtin-tools` (`[PRIMARY]` §2; we already do this) |
| **(ii) SDK-defined** | `web:search` (an SDK `defineTool`) | **generated `-e` extension** that `registerTool`s it under `piName`; `piName` added to `--tools` | **YES via the `-e` seam** — exactly how `coding-plan.ts`/`node-contract.ts` load (`[GROUND]`). NEW = *generating* that extension from the registry. |
| **(iii) MCP server** | `mcp.github:create_issue` | **generated `-e` extension bundling the MCP bridge** (à la `pi-mcp-adapter`): connect server, expose tool as `github_create_issue` (directTools) or via the proxy tool; that name added to `--tools` | **PARTIAL** — pi has **no native MCP** (`[PRIMARY]` §3). The bridge is a **NEW SDK layer** (or a vendored `pi-mcp-adapter`), but it still lands through pi's existing `-e` + `--tools` seam. |

### 6.4 What maps onto pi today vs what is a NEW SDK layer
- **Already pi mechanism (reuse, don't rebuild):**
  - allow/deny → `--tools` / `--exclude-tools` / `--no-builtin-tools` (flat bare names). `[PRIMARY]`+`[GROUND]`
  - SDK tools + MCP bridge both ride the **`-e` explicit-extension** path that survives `--no-extensions`. `[GROUND]`
  - in-loop tool gating (deny that must be *enforced*, not just hidden) → `pi.on("tool_call", {block,reason})`
    — already proven in `node-contract.ts`. `[GROUND]`
  - typed return / artifact gate → `submit_result` + `tool_call`/`agent_end` hooks (unchanged). `[GROUND]`
- **NEW SDK layer (what Pi Flow adds):**
  1. **`ToolRegistry`** — the `namespace:name → {piName, source}` table (the colon namespace is ours; pi is flat).
  2. **Compiler** — node `tools.allow/deny` (addresses) → `{ --tools, --exclude-tools, --no-builtin-tools }`
     + a **generated `-e` extension file** that `registerTool`s every `source:"sdk"` tool and wires every
     `source:"mcp"` server (bundling/vendoring the MCP adapter, since pi has no native MCP).
  3. **MCP bridge** — connection/lifecycle + name mapping (`mcp.<server>:<tool>` → `<server>_<tool>` or proxy).
  4. **Conflict/namespacing guard** — because pi+OpenClaw both use a FLAT name space with skip-on-conflict,
     the registry must guarantee distinct `piName`s (prefix SDK/MCP tools) so two sources can't collide into
     one bare name. The colon namespace is the *author-facing* uniqueness; `piName` prefixing is the
     *wire-level* uniqueness.

### 6.5 One worked compile (illustrative)
Node declares `allow: ["fs:read","web:search","mcp.github:create_issue"]`, `deny: ["fs:bash"]` →
```
pi -p --mode json -a --no-session --offline --no-extensions \
   --provider cp \
   -e providers/coding-plan.ts \
   -e <generated>/tools.<node>.ts        # registerTool(web_search); wires github MCP → github_create_issue
   --tools read,web_search,github_create_issue \
   --exclude-tools bash \
   @<prompt-file>
```
`fs:read→read`, `web:search→web_search` (generated extension), `mcp.github:create_issue→github_create_issue`
(MCP bridge). Everything lands through pi's **existing** `-e` + `--tools` surface; the colon namespace lives
only in the SDK/registry.

---

## Appendix — source list (confidence-tagged)
- `[GROUND]` in-repo: `reference/cli.md`, `reference/orchestration.md`, `docs/pi-agent-notes.md`,
  `templates/legacy/providers/coding-plan.ts`, `templates/pi-runner/extensions/node-contract.ts`.
- `[PRIMARY]` pi: https://pi.dev/docs/latest/extensions ·
  https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md ·
  .../docs/extensions.md · .../docs/sdk.md · npm `@earendil-works/pi-coding-agent`.
- `[PRIMARY]` OpenClaw: https://docs.openclaw.ai/plugins/building-plugins ·
  /plugins/sdk-entrypoints · /plugins/sdk-overview · /plugins/architecture · /tools ·
  https://open-claw.bot/docs/platforms/pi/ · issues openclaw/openclaw #47683, #61790 `[SECONDARY]`.
- `[PRIMARY]` MCP: https://modelcontextprotocol.io/specification/2025-11-25 · SEP-986
  https://github.com/modelcontextprotocol/modelcontextprotocol/issues/986.
- `[PRIMARY]` n8n: https://docs.n8n.io/integrations/builtin/node-types/ ·
  .../creating-nodes/build/reference/code-standards/.
- `[SECONDARY]` pi-mcp-adapter https://github.com/nicobailon/pi-mcp-adapter · author blog
  https://mariozechner.at/posts/2025-11-30-pi-coding-agent/.
- `[UNVERIFIED]`: OpenClaw "closed-source core" claim (public sources say MIT/open — see §4 correction);
  OpenClaw exact per-agent tool-config keys; whether a programmatic pre-call veto exists outside an extension.

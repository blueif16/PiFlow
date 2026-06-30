# Pi-native tools + the Pi "native marketplace" — what pi ships vs what piflow must add

> **What this is.** The discovery research the tool-catalog handoff owed: what tools the `pi` coding agent
> (`@earendil-works/pi-coding-agent`, pi.dev) supports NATIVELY, what its "marketplace" actually is, and the
> one fact that most shapes piflow's catalog strategy — **pi has no native MCP.** Grounded in the live pi docs
> + the pi.dev package catalog (2026-06-26). Companion to `docs/design/tool-calling-architecture.md` (the lanes)
> and `docs/design/capability-catalog.md` (the FEDERATE catalog).
>
> **Confidence:** `[PI]` = pi's own docs/README · `[CAT]` = the live pi.dev/packages catalog · `[GROUND]` = in-repo.

---

## 1. Pi's NATIVE tools (the `builtin:` lane)

Pi ships **7 built-in tools**, allowlisted by bare name via `--tools` / excluded via `--exclude-tools`
(defaults to 4): `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` `[PI: coding-agent README + docs/sdk.md]`.
- Default built-ins = `read`, `write`, `edit`, `bash`; the rest are opt-in.
- Flags: `--tools`, `--exclude-tools`, `--no-builtin-tools` (keep extension/custom, drop builtins),
  `--no-tools`. The SDK mirrors this: `createAgentSession({ tools: [...], excludeTools, noTools })`.
- **This maps 1:1 onto piflow's `BUILTIN_TOOLS`** (`fs:read/write/edit/grep/find/ls`, `sh:bash`) `[GROUND:
  tools/registry.ts:11-19]` — piflow's `builtin:` lane IS pi-native, no extension, exactly as designed.

`sourceInfo.source` values pi reports for a tool: `builtin` · `sdk` (passed via `createAgentSession({customTools})`)
· extension-registered `[PI: docs/extensions.md getAllTools()]` — the same vocabulary piflow's `ToolSource`
(`builtin|sdk|mcp|contract`) borrows.

## 2. The pi "native marketplace" = **Pi Packages** on pi.dev/packages

Pi is "aggressively extensible." Capability is added four ways, bundled as a **Pi Package** and shared via
**npm or git** `[PI]`:

| Mechanism | Format | What it adds |
|---|---|---|
| **Extensions** | TypeScript | LLM-callable custom tools (`pi.registerTool()`), event hooks, commands, UI, providers |
| **Skills** | Markdown (`SKILL.md`) | On-demand task instructions — the Agent Skills standard (agentskills.io) |
| **Prompt templates** | Markdown | `/name`-expanded reusable prompts |
| **Themes** | JSON | UI styling |

- **Install:** `pi install npm:@foo/pi-tools` or `pi install git:github.com/owner/repo`; or `-e <path|npm|git>`
  per-run. Discovery dirs: `~/.pi/agent/extensions/`, `.pi/extensions/`; custom tools at `~/.pi/agent/tools/*.ts`,
  `.pi/tools/*.ts`, or `--tool` `[PI: README, issue #190 "Custom tools" shipped v0.23.1]`.
- **The catalog (pi.dev/packages) is a real, ACTIVE npm-backed marketplace** `[CAT]`, filterable by
  type (extension/skill/theme/prompt) and sorted by downloads. Live headline packages + monthly installs:
  `pi-web-access` 118K/mo (web search/fetch/github/PDF/youtube; Exa/Tavily/Brave/Perplexity backends),
  `context-mode` 105K/mo, `pi-mcp-adapter` 98K/mo, `pi-subagents` 95K/mo, `@hypabolic/pi-hypa` 203K/mo.
- **The reference competitor lives here too:** `@quintinshaw/pi-dynamic-workflows` (20.6K/mo) — "Claude-Code-style
  dynamic workflows … fan out across 100s of subagents, model routing, token/cost accounting, resume,
  git-worktree isolation, /workflows TUI, /deep-research" `[CAT]`. This is the published form of the
  `vendor/pi-dynamic-workflows` competitor in our backlog (see [competitive-gaps-pdw]).

## 3. THE load-bearing fact: **pi has NO native MCP**

pi's README states it outright: **"No MCP. Build CLI tools with READMEs (see Skills), or build an extension
that adds MCP support."** (linking mariozechner's "what if you don't need MCP") `[PI: README]`. pi is
deliberately MCP-skeptical — MCP is NOT in the core.

MCP reaches pi only through a **third-party client EXTENSION**:
- `pi-mcp-extension` (irahardianto) — "production-ready MCP client … manages server connections, discovers
  tools, bridges them so the LLM can call them directly." Supports `stdio` / `streamable-http` / `sse`,
  cursor-paginated `tools/list`, `tools/call`, live `list_changed`; config `mcpServers: { <name>: {transport,
  url|command, lifecycle} }` `[CAT/PI]`.
- `pi-mcp-adapter` (nicobailon) — one ~200-token proxy tool; on-demand discovery; lazy server start; a
  metadata cache at `~/.pi/agent/mcp-cache.json`; `directTools` to surface specific MCP tools alongside
  `read`/`bash` `[CAT]`.

**What this means for piflow (the strategy check).** piflow's `@piflow/tool-bridge` + the generated `-e`
extension **IS piflow's own in-house MCP client for pi** — it occupies exactly the niche pi leaves open. So:
1. The catalog's **MCP-first** bet is sound precisely BECAUSE pi omits MCP: we're adding the ~9.6k-server
   universe pi can't reach natively, via our bridge, not relying on a pi-native feature `[GROUND:
   tool-calling-architecture §2 lane 4]`.
2. We are NOT competing with pi-mcp-extension — we generate a **per-node, self-contained** bridge bundle (runs
   identically local + cloud VM), which the generic pi extensions (host-wide, stdio-only) don't do.
3. **Skills are the cheapest next lane** — pi reads `SKILL.md` NATIVELY (agentskills.io standard) from
   `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`, and `--skill <path>` (repeatable), and can even
   load Claude Code / Codex skill dirs `[PI: docs/skills.md]`. So piflow's skills lane = stage `node.skill`
   into one of those paths + pass `--skill`; no bridge, no extension. This is a pi-native capability we just
   route into, exactly as the catalog plan says.

## 4. Bottom line

- **Native tools:** 7 builtins (read/write/edit/bash/grep/find/ls) — piflow's `builtin:` lane is these verbatim.
- **Native marketplace:** pi.dev/packages — npm/git Pi Packages (extensions · skills · prompts · themes),
  active and download-ranked. Our `agentType`/`node.skill`/catalog selection is how a piflow node draws from it.
- **No native MCP** — the single biggest reason our bridge-based, MCP-first catalog is additive rather than
  redundant: piflow brings pi the tool universe pi deliberately doesn't ship.

## Sources
- pi README + docs: github.com/earendil-works/pi `packages/coding-agent/{README.md,docs/sdk.md,docs/extensions.md,docs/skills.md}`; issue #190 (custom tools).
- pi.dev: `/`, `/packages`, `/packages/pi-mcp-extension`, `/packages/pi-mcp-adapter`; npm `@earendil-works/pi-coding-agent`.
- "No MCP" rationale: mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp.

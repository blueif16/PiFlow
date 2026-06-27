# Tool + Skill Ecosystem Landscape — what piflow can directly install into a node

> **What this is.** The RANKED map of the installable tool + skill universe a piflow `pi`-agent node can be
> equipped with, anchored to our **three consumption lanes** (MCP / OpenClaw / Skills). Every external claim is
> EXA-cited (URL) or marked **UNVERIFIED**. Companion to `docs/design/tool-calling-architecture.md` (the
> resolve→bind→call map) and `docs/research/openclaw-localhost-gateway-deep-dive.md` (the substrate verdict —
> NOT re-derived here). Last researched 2026-06-26.
>
> **Directness verdict legend** (how directly an ecosystem installs through OUR existing surface):
> **WORKS-TODAY** = bindable now with no new code · **SMALL-ADAPTER** = one thin import/codec, no architecture
> change · **NEEDS-BUILD** = requires a still-open piflow build step.

---

## 1. TL;DR — the highest-leverage moves

1. **Lane 2 (MCP) is the prize and it already works.** Our `@piflow/tool-bridge` routes `mcp.<server>:<tool>`
   to any stdio/HTTP MCP server via a staged `_pi/mcp.json` (`tool-calling-architecture.md` §2 lane 4 = ✅).
   The directly-addressable universe is **~9,600 distinct connectable servers** (official-registry deduped
   floor) up to **~17.5k** counting wrappers/forks ([alatirok.com census, 2026-06-02](https://alatirok.com/mcp-server-statistics-2026/)).
   The single gap is provisioning: nothing seeds `mcpConfig` into the canonical CLI run path
   (`tool-calling-architecture.md` §5). **Close that one gap → the whole MCP universe is live per-node.**

2. **Equip from a registry API, not a hand-list.** Every major MCP registry exposes a read API — the **official
   MCP Registry** (`GET /v0.1/servers`, cursor-paginated, [registry.modelcontextprotocol.io](https://modelcontextprotocol.io/registry/registry-aggregators)),
   **Glama** (`GET /api/mcp/v1/servers`), **Smithery** (`registry.smithery.ai/servers`), **PulseMCP** (Sub-Registry
   API). piflow should treat the official registry as its canonical metadata source and mirror it into a local
   **capability catalog** (§6), so a node author picks `mcp.*` addresses from real, dated data.

3. **Skills are WORKS-TODAY because pi IS the loader.** pi implements the [Agent Skills standard](https://agentskills.io/specification)
   and auto-discovers `SKILL.md` from `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`, pi-packages, and
   `--skill <path>` ([earendil-works/pi skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md)).
   Our `node.skill` (`types.ts:29`) + `agentType.skills[]` (`agent-preset.ts:26`) already feed this. The
   community supply is **thousands** of `SKILL.md` packs (VoltAgent awesome-agent-skills lists 1,497+;
   aggregators claim 8k–69k+). Dropping a skill folder into the workspace skills tree needs **zero new code**.

4. **OpenClaw (`oc.*`) is breadth-rich but the install loop is still NEEDS-BUILD.** ClawHub (OpenClaw's
   registry) has a **public read API** (`GET /api/v1/packages` with `family`/`channel`/`category`/`capabilityTag`
   filters — [ClawHub HTTP API](https://documentation.openclaw.ai/clawhub/http-api)) and **90 core + 36 official
   external plugins** documented ([plugin inventory](https://docs2.openclaw.ai/plugins/plugin-inventory)). But
   per the deep-dive, `oc.*` community tools are *discoverable, not yet executable* in a live run (acquisition/
   packaging is the open step). Integrate AFTER MCP + Skills.

5. **Integration order: MCP-provisioning → Skills-catalog → OpenClaw-packaging.** Ranked decision table in §5.

---

## 2. Lane 2 — MCP servers (the biggest + already-supported)

**Our lane:** `mcp.<server>:<tool>` → `@piflow/tool-bridge` `callTool` → server config in staged `_pi/mcp.json`
(stdio local / Streamable-HTTP remote). **Verdict: WORKS-TODAY** for any node that authors `mcp.servers`
(`tool-calling-architecture.md` §2 lane 4, §5; the runner stages it `runner.ts:947-960`). This is the lane to
lead with — it is the largest directly-installable universe in existence and our bridge already speaks it.

### 2a. The registries — concrete counts, enumeration, install mechanisms

| Registry | Approx server count (dated) | How enumerated | Install mechanisms it surfaces | Our directness |
|---|---|---|---|---|
| **Official MCP Registry** (`modelcontextprotocol/registry`) | **9,652** deduped latest records (May 24 2026); 28,959 incl. all versions ([alatirok census](https://alatirok.com/mcp-server-statistics-2026/)) | **Read REST API**: `GET /v0.1/servers` cursor-paginated, `?search=&updated_since=&version=latest`, max 100/page; unauthenticated; aggregators scrape hourly ([aggregator docs](https://modelcontextprotocol.io/registry/registry-aggregators)) | `server.json` declares `packages[]` (npx/uvx/docker/nuget/pypi runtimeHint) + `remotes[]` (Streamable-HTTP/SSE) | **WORKS-TODAY** (canonical source to mirror) |
| **Glama** | **48,988 servers · 6,709 connectors · 312,594 tools** (indexed Jun 26 2026 — [glama.ai](https://glama.ai/)) | **Read API**: `GET /api/mcp/v1/servers` free-text `query` + cursor `after`; per-server `/servers/:id` ([Glama search API](https://glama.ai/blog/2025-03-24-mcp-discord)) | npx/docker/remote per listing; largest raw index | **WORKS-TODAY** |
| **mcp.so** | **~19.4k–22.8k** (22,824 self-reported home; 20,222 Apr 2026 census) ([mcp.so](https://mcp.so/), [census](https://alatirok.com/mcp-server-statistics-2026/)) | Marketplace index (Next.js+Supabase, `chatmcp/mcpso`); GitHub-issue submission; scrape | npx/uvx/docker; no one-click install | **WORKS-TODAY** (discovery; lowest curation) |
| **Smithery** | **~6,000–7,300** (7,300+ May 2026; quality-filtered) ([apigene](https://apigene.ai/blog/smithery-cli), [hivebook](https://www.hivebook.wiki/wiki/smithery-mcp-server-registry-hosting-connection-platform-7-300-mcp-servers...)) | **Platform API** `registry.smithery.ai/servers` (useCount, verified); 55 ops / 35 paths ([api-evangelist](https://github.com/api-evangelist/smithery)) | CLI one-command install; **Connect gateway** (`mcp.smithery.run`) proxies streamable-HTTP behind one endpoint + managed OAuth | **WORKS-TODAY** direct; gateway = SMALL-ADAPTER |
| **Docker MCP Catalog/Toolkit** | **300+** verified, containerized ([Docker docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/)) | YAML index on Docker Hub `mcp` namespace; browsable in Docker Desktop | **docker** image per server; OAuth handled by Toolkit; MCP Gateway routes | **WORKS-TODAY** (our bridge can spawn a `docker run` stdio server) |
| **PulseMCP** | **~18,588** (curated, low-quality omitted; 16,500+ "daily") ([pulsemcp.com/servers](https://www.pulsemcp.com/servers)) | **Sub-Registry API** (Generic MCP Registry API + enrichment: popularity, security analysis) ([API docs](https://www.pulsemcp.com/api/docs/v0.1)) | Mirrors official `server.json` (stdio/npx + remotes) + enriched metadata | **WORKS-TODAY** (best for popularity/security signal) |
| **Awesome-MCP lists** | punkpeye/awesome-mcp-servers **90K★**, ~46 categories, synced to Glama; TensorBlock **7,747** links / ~35 cats ([punkpeye](https://github.com/punkpeye/awesome-mcp-servers), [TensorBlock](https://github.com/tensorblock/awesome-mcp-servers)) | Markdown (scrape) or structured dataset mirror ([essentialols dataset: 1,631 servers / 46 cats](https://github.com/essentialols/awesome-mcp-servers-data)) | Per-entry npx/uvx/docker | **WORKS-TODAY** (human-curated shortlist) |

**Census reconciliation** ([alatirok.com, 2026-06-02](https://alatirok.com/mcp-server-statistics-2026/)): the
defensible band is **~9.6k distinct connectable servers** (official-registry dedupe, the protocol-native floor;
Anthropic's own Dec-2025 figure was ">10,000 active public") up to **~17.5k** in the broadest 6-registry union.
Raw directory indexes (mcp.so 20k, Glama 49k) lean on un-deduplicated submissions/wrappers — great for
discovery, inflated for census. **For piflow: mirror the official registry as the canonical floor; use
Glama/PulseMCP for enrichment.** Ecosystem is growing ~38% per 4 months; ~97M+ monthly SDK downloads
([VibeDNA](https://www.vibedna.ai/blog/state-of-mcp-servers-2026)).

**Install-mechanism vocabulary our bridge must speak** (all already supported by the staged `_pi/mcp.json`
shape — stdio command or remote URL):
- **stdio** — `npx -y <pkg>` (TypeScript servers), `uvx <pkg>` (Python servers), `docker run <image>` (Docker
  Catalog). Local subprocess; our bridge spawns it. **WORKS-TODAY.**
- **remote** — Streamable-HTTP (`type: "streamable-http"`) or SSE, e.g. `https://mcp.exa.ai/mcp`. Our bridge
  routes to it directly; cloud runs MUST mint a scoped token host-side (`tool-calling-architecture.md` §6).
  **WORKS-TODAY** (the only nuance is the secret seam for keyed remotes).

### 2b. Capability-domain map — flagship servers per high-value domain

All install via our bridge **DIRECTLY today** (stdio/remote) unless flagged. Picks below are the load-bearing,
"getting work done" servers.

| Domain | Flagship servers (install mechanism) | Bridge-direct today? |
|---|---|---|
| **Web / search** | **Exa** `https://mcp.exa.ai/mcp` (remote HTTP; `web_search_exa`/`web_fetch_exa`/`web_search_advanced_exa` — [exa.ai/docs](https://exa.ai/docs/reference/exa-mcp)) · Tavily · Firecrawl · Brave Search (`npx`) | ✅ direct (Exa = our search example) |
| **Code / dev / VCS** | **GitHub** official (`https://api.githubcopilot.com/mcp/` remote, or `npx @modelcontextprotocol/server-github`; toolsets: repos/issues/PRs/actions/code_security — [github/github-mcp-server](https://github.com/Github/github-mcp-server)) · GitLab · Git (`uvx mcp-server-git`) | ✅ direct |
| **Data / DB / warehouse** | **PostgreSQL** (`npx @modelcontextprotocol/server-postgres <url>` — [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers)) · **Neon** (`https://mcp.neon.tech/sse`) · Supabase · Snowflake/BigQuery (community) | ✅ direct |
| **Cloud / infra** | AWS (Docker Catalog) · Cloudflare · Kubernetes · Stripe (`https://mcp.stripe.com/` — [MCP Playground](https://mcpplaygroundonline.com/mcp-servers)) · Elastic, Neo4j (Docker Catalog beta — [Docker announce](https://www.docker.com/blog/announcing-docker-mcp-catalog-and-toolkit-beta/)) | ✅ direct |
| **Browser / automation** | **Playwright** (`npx @playwright/mcp@latest`, 34K★ — [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)) · Puppeteer · browser-use | ✅ direct |
| **Comms / productivity** | **Slack** (`https://mcp.slack.com/mcp`) · **Notion** (`npx @notionhq/notion-mcp-server` or `https://mcp.notion.com/mcp` — [makenotion](https://github.com/makenotion/notion-mcp-server)) · Linear · Jira · HubSpot (`https://mcp.hubspot.com`) | ✅ direct |
| **Files / docs / memory** | **Filesystem** (`npx @modelcontextprotocol/server-filesystem <dir>`) · **Memory** (`npx @modelcontextprotocol/server-memory`) · Google Drive | ✅ direct |
| **Finance** | Stripe (above) · finance/crypto category (445 servers in TensorBlock index) · market-data community servers | ✅ direct (keyed) |
| **Design / multimedia** | Figma MCP · multimedia-processing category (212 servers, TensorBlock) · image/video tooling | ✅ direct |

**Need-a-gateway exceptions** (not bridge-direct): Smithery **Connect gateway** and Docker **MCP Gateway** are
optional aggregation layers (one endpoint behind many servers + managed OAuth) — useful but a SMALL-ADAPTER, not
required, since our bridge already speaks raw stdio/HTTP. Docker AI-Governance MCP Gateway is invite-only.

---

## 3. Lane 1 — OpenClaw community breadth (the `oc.*` lane)

**Our lane:** we host the OpenClaw plugin **substrate** in-process on pi (NO OpenClaw app install). Substrate
mechanics are settled and NOT re-derived here — see `docs/research/openclaw-localhost-gateway-deep-dive.md` and
`docs/design/openclaw-substrate-adoption.md` (S0–S3 implemented; request/response + provider + keyed-state +
nested-agent tier runs; long-running/device-bus tier deferred). This section is **breadth + the enumerate/
install surface only.**

### 3a. ClawHub — the enumerate/install surface (it has a real API)

**ClawHub is OpenClaw's public registry for skills + plugins** ([docs.openclaw.ai/clawhub](https://docs.openclaw.ai/clawhub)).
Critically for us, it exposes **public read APIs** — so enumeration is programmatic, not a scrape
([ClawHub HTTP API](https://documentation.openclaw.ai/clawhub/http-api)):
- `GET /api/v1/packages` — list, cursor-paginated (limit 1–100), filterable by **`family`** (`skill` /
  `code-plugin` / `bundle-plugin`), **`channel`** (`official` / `community` / `private`), `isOfficial`,
  **`executesCode`**, **`capabilityTag`**, **`category`**.
- `GET /api/v1/packages/search`, `GET /api/v1/plugins`, `GET /api/v1/code-plugins`, `GET /api/v1/bundle-plugins`.
- Plugin **category** enum (the agent-tool taxonomy): `channels`, **`mcp-tooling`**, `data`, `security`,
  `observability`, `automation`, `deployment`, `dev-tools`.
- Self-hostable registries advertise via `/.well-known/clawhub.json`.

Install verbs ClawHub surfaces: `openclaw plugins install clawhub:<package>`, `openclaw skills install
@openclaw/<name>`, `clawhub install <pkg>` — but per our adoption decision **we never run the `openclaw` CLI**;
ClawHub is a HOST/INGEST-side *source* we mirror, not a runtime we shell out to.

### 3b. How big beyond the monorepo

| Slice | Count | Source |
|---|---|---|
| **Core npm package plugins** | **90** | [plugin inventory](https://docs2.openclaw.ai/plugins/plugin-inventory) (generated from `extensions/*/package.json`) |
| **Official external packages** (ClawHub/npm on-demand) | **36** | same |
| **Tool-bearing, non-channel (inheritable by us)** | **64 tools / 19 plugins** (census of 135 manifests); 10 tool-bearing bundled in npm | `openclaw-substrate-adoption.md` (live-proven S1) |
| **Community channel (`channel=community`)** | **UNVERIFIED count** — the API exposes the channel + `capabilityTag` filters but no public total was confirmed; query `GET /api/v1/packages?channel=community&family=code-plugin` to get the live number | [HTTP API](https://documentation.openclaw.ai/clawhub/http-api) — count not stated |

**Tools vs providers/channels:** the bulk of the 90 core plugins are **model PROVIDERS** (anthropic, deepseek,
cerebras, cohere, byteplus, …) and **channels** (discord, clickclack) — NOT agent tools. pi already *is* the
provider layer, so those are out (`openclaw-substrate-adoption.md` scope). The agent-TOOL subset is the
~19-plugin / 64-tool inheritable set (workboard 34, memory ×3, browser/canvas/files/diffs, firecrawl/tavily/xai
keyed, llm-task). **Filter ClawHub on `family=code-plugin` + a tool `capabilityTag`, exclude `category=channels`,
to enumerate only the agent-useful surface.**

**Directness verdict: NEEDS-BUILD.** `oc.*` community tools are *discoverable, not executable* in a live run
today (`tool-calling-architecture.md` §5): (1) git-source refs route to the bridge not native-bind, and (2) the
reserved `openclaw` server is never provisioned in the CLI path. The open step is **acquisition/packaging** (no
clean per-plugin npm packages; needs a piflow-side packing step — `tool-calling-architecture.md` §4, decision
A/B). Substrate load+execute itself is PROVEN-OFFLINE.

---

## 4. Lane 3 — Skills (the `node.skill` lane)

**Our lane:** a node carries `skill?: string` (`types.ts:29`); `agentType` presets bundle `skills[]`
(`agent-preset.ts:26`, merged author-time by `mergePreset`: `skill = node.skill ?? preset.skills?.[0]`); skills
load from the `{{WORKSPACE}}` skills tree.

### 4a. The format + why this is WORKS-TODAY

A **skill is a folder with a `SKILL.md`** = YAML frontmatter (`name` + `description` required; description is the
trigger) + Markdown instructions + optional `scripts/`, `references/`, `assets/`. Three-level progressive
disclosure: metadata always in prompt (~100 words) → body on trigger (<500 lines) → bundled files on demand
([Anthropic Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills),
[anthropics/skills](https://github.com/anthropics/skills), [spec](https://anthropics-skills.mintlify.app/spec/overview)).

**The decisive fact: pi natively implements the Agent Skills standard.** pi loads `SKILL.md` from
`~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, `.agents/skills/` (cwd→repo root), pi-packages
(`pi.skills` in `package.json`), and `--skill <path>` (repeatable); it injects skill metadata into the system
prompt as XML and exposes `/skill:name`
([earendil-works/pi skills.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md),
[npm readme](https://registry.npmjs.org/@earendil-works/pi-coding-agent)). **So our `{{WORKSPACE}}` skills tree
maps onto pi's discovery directly — there is no piflow-side skill loader to build.** `node.skill` already names
one; the runner just needs to stage that skill folder into a pi-discoverable path (or pass `--skill`).

### 4b. The supply

| Source | Count (dated) | Notes |
|---|---|---|
| **Anthropic `anthropics/skills`** | curated set across Creative/Design, Dev/Technical, Enterprise/Comms + production DOCX/PDF/PPTX/XLSX | the reference repo + spec + template ([anthropics/skills](https://github.com/anthropics/skills)) |
| **VoltAgent `awesome-agent-skills`** | **1,497+** ("hand-picked, not AI-slop"; 26K★) — Anthropic, Google, Vercel, Stripe, Cloudflare, Figma, HuggingFace teams | [VoltAgent](https://github.com/VoltAgent/awesome-agent-skills) |
| **claudeskills.info** | **658+** (35 official + 623 community) | [marketplace](https://claudeskills.info/skills/) |
| **bg-szy/TOP-SKILLS** | **3,900+** from 13 repos, daily-synced | [TOP-SKILLS](https://github.com/bg-szy/TOP-SKILLS) |
| **Aggregator high-end claims** | agentskill.sh "69,000+"; SkillKit "400K+ across 44 agents"; AgentSkills.so 4,861 | **treat as UNVERIFIED ceilings** ([automationswitch skills](https://automationswitch.com/skills)) — bulk/AI-generated; quality varies wildly |

**Defensible read:** the *curated, real-team* skill supply is **~1.5k–4k** (VoltAgent, TOP-SKILLS); the
long-tail aggregator numbers are inflated and unvetted. Skills are cross-platform by the open standard
(Claude Code, Codex, Cursor, Copilot, pi all read `SKILL.md`), so a curated skill drops into pi unchanged.

### 4c. How skills COMPLEMENT tools (procedure vs capability)

A **tool** is a *capability* (an `execute` that does an external thing — call an API, run a browser). A **skill**
is a *procedure* (instructions + scripts that tell the agent HOW to use the capabilities it has, in a repeatable
way). Example: the `mcp.github:*` tools give a node the *capability* to touch GitHub; a `pr-review` skill gives
it the *procedure* for a good review. They stack: `agentType` preset = (role-prompt + `skills[]` + base `tools`),
so a node author equips both at once. Skills with `scripts/` can also carry deterministic helpers the agent runs
via `bash` — capability without a tool binding.

---

## 5. Ranking — what to integrate first (the decision table)

Sorted by **value × directness**. "Breadth" = installable count; "Directness" = works through our lane today;
"Value" = capability for getting real work done; "One integration step" = the single move to unlock it.

| Rank | Ecosystem / registry | Lane | Breadth (count) | Directness | Capability value | The ONE integration step |
|---|---|---|---|---|---|---|
| **1** | **MCP via Official Registry** (mirror as canonical) | 2 | **~9.6k** distinct (floor) | **WORKS-TODAY** (bridge speaks stdio/HTTP) | **Highest** — every domain in §2b | **Seed `mcpConfig` into the canonical CLI run path** (close `tool-calling-architecture.md` §5 gap) + a sync of `GET /v0.1/servers` into a local catalog |
| **2** | **Skills (Anthropic + curated community)** | 3 | **~1.5k–4k** curated | **WORKS-TODAY** (pi is the loader) | **High** — encodes "how to do the task well"; pairs with every tool | **Stage `node.skill` folders into a pi-discoverable skills path** (or pass `--skill`); mirror a curated set into `{{WORKSPACE}}` |
| **3** | **MCP via Glama/PulseMCP enrichment** | 2 | 49k raw / 18.5k curated | **WORKS-TODAY** (same bridge) | **High** — popularity + security signal for ranking picks | **Add Glama/PulseMCP fields (useCount, security) to the catalog** built in rank 1 |
| **4** | **Docker MCP Catalog** | 2 | **300+** verified containers | **WORKS-TODAY** (bridge spawns `docker run` stdio) | **Med-High** — verified, provenance, OAuth-managed | **Allow `docker run` as a `_pi/mcp.json` command shape** + map Catalog YAML → server config |
| **5** | **Smithery (+ Connect gateway)** | 2 | **~7,300** quality-filtered | direct WORKS-TODAY; gateway SMALL-ADAPTER | **Med-High** — fastest discovery + managed OAuth via one endpoint | **(optional) Point one bridge server at `mcp.smithery.run` for managed-OAuth fan-out** |
| **6** | **OpenClaw tool plugins via ClawHub** | 1 | **64 tools / 19 plugins** inheritable (+ community `capabilityTag` tail, UNVERIFIED) | **NEEDS-BUILD** (substrate proven; acquisition open) | **Med** — workboard/memory/diffs/scrape not all in MCP | **Build the per-plugin packing step + provision the reserved `openclaw` server** (`tool-calling-architecture.md` §4) |

**Read of the table:** ranks 1–5 are all **WORKS-TODAY or one small adapter** and together cover essentially
every capability domain — so the entire near-term win is **Lane 2 + Lane 3 with no new architecture**, gated only
by the *one* MCP-provisioning fix. OpenClaw (rank 6) adds a modest non-overlapping tail (workboard, memory-wiki)
but is the only NEEDS-BUILD item — do it last.

---

## 6. Per-node equipping implication (Thread B) — task → tools+skills

**The existing surface a node author already has:**
- `node.tools` = `ToolSelection { allow?: string[]; deny?: string[] }` (`types.ts:46`/`243`), addressed
  `namespace:name` — `builtin` (`fs:read`), `oc.<plugin>:<tool>`, `mcp.<server>:<tool>`.
- `node.skill?: string` (`types.ts:29`) — one skill to load + follow.
- `agentType` preset (`agent-preset.ts:23-34`, `mergePreset` `:64`) — author-time bundle of `{ role-prompt +
  skills[] + base tools.allow/deny + display }`, additive-merged into the node (preset is the base, node adds;
  deny wins; node's skill wins, preset's first is fallback).
- Tool provenance already modeled: `ToolEntry.origin = { kind: 'native' | 'openclaw-plugin' | 'mcp-server' }`
  and `ToolRegistry.search(query)` (`types.ts:672-723`) — i.e. **the catalog + search seam already exists in
  the type system.**

**What a "capability catalog + task→tool match" needs to look like** (so designing a node = picking from this
universe), built ONLY on the above:

1. **A capability catalog = the mirrored registries as `ToolEntry[]`.** Sync the official MCP Registry
   (`GET /v0.1/servers`) → one `ToolEntry` per server-tool, `address = mcp.<server>:<tool>`,
   `origin.kind='mcp-server'`, `tags` from the registry category, `description` from `server.json`. Enrich with
   Glama/PulseMCP useCount + security. Add the curated skills as catalog rows too (a skill is a *procedure*
   capability keyed by its `description` trigger). Store the snapshot in `~/.piflow/` (the global-index rule —
   never in `packages/*` or the GUI), parallel to `index.json`.

2. **task→tool match = `ToolRegistry.search(query)` over that catalog.** The design agent (piflow-init COMPOSE)
   takes the node's task prose, runs `search()` (the SDK seam already declared, `types.ts:721`) against the
   catalog `description`/`tags`, and emits the matched `mcp.*`/`oc.*` addresses into `node.tools.allow` + the
   single best skill into `node.skill`. A matched MCP server also emits its `node.json.mcp.servers` entry
   (`NodeIntent.mcp`, `types.ts:848`) so the runner stages `_pi/mcp.json`.

3. **agentType presets = the reusable "loadout."** Common task shapes (a "researcher" = `web:search` +
   `mcp.exa:*` + a `deep-research` skill; a "vcs-engineer" = `mcp.github:*` + a `pr-review` skill) become
   `~/.piflow/agents/<id>.md` presets. The author picks one `agentType` and `mergePreset` flattens the right
   tools+skills into the node at author time — so **picking a loadout from the universe is already exactly the
   preset mechanism**, just fed by the catalog.

**Net:** the equipping path is **task prose → `search()` over the mirrored capability catalog → `node.tools.allow`
+ `node.skill` (+ `node.json.mcp.servers`), or a one-pick `agentType` preset that bundles them** — all on the
real existing fields, no invented mechanism. The only new artifact is the catalog snapshot in `~/.piflow/`, and
the only new runtime wiring is the §5-rank-1 MCP-provisioning fix.

---

## Bar Audit

| Criterion | PASS/FAIL | Evidence |
|---|---|---|
| 1. Every ecosystem EXA-cited w/ concrete counts + install mechanisms (not "many") | **PASS** | §2a table: 6 registries each with dated count + API + install verbs + URL; §2b flagships w/ npx/uvx/docker/URL; §3b/§4b counts cited; UNVERIFIED items flagged (ClawHub community total, aggregator skill ceilings) |
| 2. Every ecosystem mapped to one of 3 lanes + directness verdict | **PASS** | Every row tags Lane 1/2/3 + WORKS-TODAY / SMALL-ADAPTER / NEEDS-BUILD (legend §intro; §2 lane 2, §3 lane 1, §4 lane 3, §5 table column) |
| 3. Lane 2 most developed: ≥5 named registries w/ counts + ≥8 capability categories w/ flagships | **PASS** | §2a = **6** registries (Official/Glama/mcp.so/Smithery/Docker/PulseMCP) + Awesome lists; §2b = **9** domains, each w/ 2–4 flagship servers + install mechanism |
| 4. §5 RANKS (sorts) by value×directness w/ the one integration step each (decision table) | **PASS** | §5 table sorted rank 1–6, each row has breadth + directness + value + "the ONE integration step" |
| 5. §6 ties to REAL existing fields (`types.ts:29`/`46`, `agent-preset.ts:26`), no invented mechanism | **PASS** | §6 cites `types.ts:29/46/243/672-723/848`, `agent-preset.ts:23-34/64`; reuses `ToolRegistry.search`, `ToolEntry.origin`, `NodeIntent.mcp`, `mergePreset`, `~/.piflow/` index rule |
| 6. Substrate internals NOT re-derived; OpenClaw section = breadth + enumerate/install only | **PASS** | §3 cites deep-dive + adoption doc for mechanics; covers only ClawHub API + counts + tools-vs-providers split |
| 7. Report file written | **PASS** | this file: `docs/research/tool-skill-ecosystem-landscape.md` |

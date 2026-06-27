# Tool-Calling Architecture — system map & live status

> **What this is.** The single navigable map of every way a tool gets **resolved → bound → called** in piflow,
> with current status. Companion to `node-action-protocol.md`: that doc owns the **node authoring surface**
> (`tools.allow/deny`, hooks, the `op[]` envelope — *what a node declares*); THIS doc owns **what happens to a
> declared tool address downstream** — which lane binds it, where its `execute` runs, and whether it works today.
>
> **Reference, don't duplicate.** Detail lives in the linked docs; this is the index + the status table. Deep
> OpenClaw analysis: `docs/research/openclaw-localhost-gateway-deep-dive.md` (the FINAL architecture verdict).
>
> **Status: LIVING.** Last reconciled 2026-06-26. The plugin-lifecycle row is being settled by
> `docs/research/spike-full-plugin-loop.md` (in progress).

---

## 1. The address space

Every tool a node selects is one of three address families (`tools.allow` entries):

| Family | Example | Bound by | Detail |
|---|---|---|---|
| **builtin** (bare name) | `fs:read`, `sh:exec`, `web:search` | pi natively — no `-e`, no bridge | pi binary has them; `--tools` allowlists |
| **`oc.<plugin>:<tool>`** | `oc.calc:add`, `oc.workboard:workboard_create` | native-bind in `-e` **or** the OpenClaw plugin host | split by `origin.ref` (importable vs git-source) — see §2 |
| **`mcp.<server>:<tool>`** | `mcp.github:create_issue` | the bridge → an MCP server | `callTool` → staged `_pi/mcp.json` |

Address parsing: `packages/tool-bridge/src/address.ts` (`oc.*` → reserved server `openclaw`; `mcp.*` → its named server).

---

## 2. The calling lanes (the core map)

| # | Lane | How `execute` binds | Where it runs | Status today |
|---|---|---|---|---|
| 1 | **builtin** | pi-native | inside pi | ✅ works |
| 2 | **native-sdk** (`oc.calc:add`) | importable `origin.ref` → `pluginModuleFromRef` returns a specifier (`compile.ts:106`), `isNativeSdk` true (`:140`), native `execute` captured by the shim and **inlined into the `-e`** (`compile.ts:172-199`, `openclaw-shim.ts`) | inside pi (self-contained `-e` bundle) | ✅ **only lane that closes the loop in a live run** |
| 3 | **`oc.*` community** | git-source `origin.ref` (`#…`) → non-importable (`compile.ts:108`) → renders `execute → callTool('oc.…')` → reserved `openclaw` server | **COMMITTED:** our in-process host (`openclaw-host.ts`) drives `factory(ctx).execute(...)` | ⚠️ **discoverable, NOT executable** — see §5 |
| 4 | **`mcp.*`** | renders `execute → callTool('mcp.…')` (`compile.ts:191-198`) → bridge looks up the server in `_pi/mcp.json` | the MCP server (stdio local / HTTP remote) | ✅ works **iff** a node authors `mcp.servers` (runner stages it: `runner.ts:947-960`) |

**The bridge** (`packages/tool-bridge`): `callTool(address, params)` (`index.ts:62`) → `parseAddress` → look up server config (from `configureBridge` or the `PIFLOW_MCP_CONFIG` file) → MCP `tools/call`. `oc.*` routes to the reserved server `openclaw` (`OPENCLAW_SERVER`, `address.ts:41`).

**Delivery:** the `-e` is one **self-contained esbuild bundle** (externals = pi-injected specifiers only; `compile.ts:312-325`, `tool-bridge-delivery-2026-06-21.md`) — so the same `-e` runs unchanged on the host and in an empty cloud VM.

---

## 3. The committed substrate — in-process host ("SDK, not a gateway")

Decided + converged across two independent investigations (`pi-tools-extensions-openclaw-2026-06-21.md:5` "as an
SDK, NOT a gateway"; the vendored-source deep-dive §7): **run the OpenClaw plugin runtime ourselves, in-process
on pi — never spawn OpenClaw's gateway as a foreign service.**

- **What it serves in-process** (needs only a `runtime` shim — real keyed-store/SQLite + `SecretResolver` +
  `runEmbeddedAgent`→nested pi): memory-core, memory-wiki, workboard, tavily, firecrawl, xai, diffs, llm-task.
- **Deferred (L3 / node-bus tier)** — needs a long-running service daemon or paired-device bus: browser,
  canvas, file-transfer, codex-supervisor. Honest v1 boundary, not a blocker. (`l2-l3-boundary-map.md`.)
- **One host, two transports = the "same `oc.*` channel local & remote":** expose the host as the reserved
  `openclaw` server over **stdio** (a local pi run) and **our own Streamable-HTTP** (a Daytona VM, which is the
  *client*). The generated `-e` never changes; only the server's transport differs. OpenClaw ships **no**
  networkable plugin-tool server (`plugin-tools-serve` is stdio-only), so the HTTP face is **ours**.

Host today: `packages/core/src/tools/openclaw-host.ts` (built through S0–S3) — **orphaned** from the run path
(imported only by its tests). Wiring it in = the committed work.

---

## 4. Plugin lifecycle — discover → acquire → install → load → execute (NO OpenClaw install)

The product must require **no OpenClaw install**; the user never knows OpenClaw exists.

1. **Discover** — browse/search our registry-as-code catalog by `oc.<plugin>:<tool>` (built: `catalog.ts`,
   `openclaw-community.ts`, ingest `openclaw-plugin-sourcing-2026-06-21.md`). No OpenClaw.
2. **Acquire** — ⚠️ the standalone `@openclaw/<name>` packages are **NOT on public npm** (404, or a 0-byte
   "Bootstrap reservation" placeholder); real code ships only inside the **86 MB umbrella `openclaw`** package
   or the MIT GitHub source. And a bundled dist extension is **not a copyable unit** — each
   `extensions/<name>/index.js` is the tip of a hashed shared-chunk web (`duckduckgo` = 101 files, `workboard`
   = 287). So acquisition needs a **piflow-side packaging step** that emits a self-contained per-plugin pack.
   **Open decision:** (A) esbuild a standalone pack from the MIT source `openclaw/openclaw@<tag>:extensions/<name>/`
   (clean, we own the build); (B) `npm pack openclaw` once + extract each plugin's transitive closure (proven
   by the spike, but drags ~100–290 shared chunks/plugin); or mirror **ClawHub** (OpenClaw's registry) — but
   never the `openclaw` CLI. The umbrella is a HOST/INGEST-side input only; the user's machine only ever gets
   the small per-plugin pack.
3. **Install to** — a piflow-owned cache `~/.piflow/extensions/<name>@<ver>/`, **each with its own
   `node_modules`** for declared deps (PROVEN). Parallels OpenClaw's own `$OPENCLAW_STATE_DIR/extensions/<id>/`
   and the project `~/.piflow/` rule. Never our node_modules; never `openclaw`.
4. **Load + host** — the host loads the cached plugin + the **vendored** `@openclaw/plugin-sdk` (the one
   OpenClaw-origin piece in our SDK — unpublished; vendor the **built 1.27 KB `definePluginEntry` slice**, NOT
   the 63-export source façade) + the `runtime` shim, drives execute.
5. **Run** — the captured execute is esbuild-bundled into the `-e` → the VM needs nothing either.

> **Status: PROVEN-OFFLINE** (`spike-full-plugin-loop.test.ts`, 5/5 green; deep-dive §9). `@openclaw/duckduckgo-plugin`
> loads + reaches execute from a `~/.piflow`-style cache with **no `node_modules/openclaw` in the runtime
> closure** (external HTTP search is network-gated). The host must change its plugin resolution
> (`openclaw-host.ts:571/578`) to read the cache, not `node_modules/openclaw`. **The one open question is
> ACQUISITION/packaging (step 2)** — load+execute is settled.

---

## 5. Current status — what executes TODAY

| Address | Executes E2E in a live pi run? | Why / the gap |
|---|---|---|
| `builtin:*` | ✅ yes | pi-native |
| `oc.calc:add` | ✅ yes | the one native-bind seed (importable ref) |
| `oc.*` community | ❌ no — **discoverable only** | two independent reasons: (1) git-source ref → bridge, not native; (2) the reserved `openclaw` server is **never provisioned** (`cli/run.ts:375` passes no `mcpConfig`/`secretResolver`) |
| `mcp.*` | ✅ if authored | works when a node declares `mcp.servers`; nothing auto-provisions the reserved `openclaw` server |

**The single live-path gap** (`2026-06-25-node-action-…:134` blocker #1, re-traced): the catalog/`mcpConfig`
is never seeded into the canonical CLI run path, so any `oc.*`/`mcp.*` selection has no server to reach.

---

## 6. Credential / secret flow

`SecretResolver` (`types.ts:619,625`) is the single seam. `_pi/mcp.json` carries **`$VAR` refs, never literal
secrets**; the runner stages it + injects `PIFLOW_MCP_CONFIG` + the referenced env vars only for nodes that
selected a bridge tool (`runner.ts:947-960`, `selectedBridgedTool` `:438`). Local MAY passthrough env; **cloud
MUST allowlist** (`CLOUD_KINDS`) and mint a **short-lived scoped token** host-side, never the raw key
(`cloud-tool-gateway-architecture.md §D`, `tool-bridge-env-2026-06-21.md`). For the in-process host, the same
resolver routes a key into `plugins.entries.<id>.config.<path>` before execute (`openclaw-host.ts` S2).

---

## 7. Committed plan — the build path (highest-leverage first)

Strategy (deep-dive + landscape + catalog research, all converged): **MCP first (biggest, already-wired),
skills second, OpenClaw later.** Most of the seam is already built.

1. **Catalog client — FEDERATE** (design: `capability-catalog.md`). A `~/.piflow/catalog/` client that queries
   upstream registries (MCP Official Registry, ClawHub, agent-skills `.well-known`), caches an index slice for
   offline search, and downloads artifacts only on install. No piflow-hosted catalog. Feeds
   `ToolRegistry.search` (`types.ts:721`).
2. **Close the live-path gap — the seam EXISTS.** `assembleRunTools({ spec, extraEntries, mcpListings })`
   (`tool-config.ts:60`) already accepts host-fetched catalog rows; `resolveRunTools` (`entry.ts:41`) calls it
   with `{ spec }` only today. The catalog client is the missing **caller**: pass `extraEntries`/`mcpListings`
   + thread `mcpConfig`/`secretResolver` through `cli/run.ts:375`. **This one wiring unlocks the ~9.6k MCP
   universe AND `oc.*`.**
3. **Skills:** stage `node.skill` folders into a pi-discoverable skills path (pi natively reads `SKILL.md`).
4. **OpenClaw (parallel/later):** the in-process host (§3) + per-plugin packing (§4) + provision the reserved
   `openclaw` server. The hardest lane; not the critical path.

**Verification still owed (engineering, not architecture):**
- An MCP server tool executing through a **live pi node** (the bridge→server lane is proven by
  `tool-bridge-real-servers.e2e`; the node-run path needs the §7.2 seed).
- Per-plugin OpenClaw execute breadth beyond the 3 proven (workboard, memory-wiki, …).
- The Streamable-HTTP face for remote `oc.*`.
- The full no-OpenClaw loop is **PROVEN-OFFLINE** (`spike-full-plugin-loop.test.ts`).

---

## 8. Capability sources — ranked (what to install, in priority order)

Full landscape + counts/registries: `docs/research/tool-skill-ecosystem-landscape.md`. **The reorder that matters:
OpenClaw is real but the hardest/last lane; the biggest *already-working* universe is MCP.**

| Rank | Source | Lane | Breadth | Install directness | The one step |
|---|---|---|---|---|---|
| 1 | **MCP — Official Registry** | `mcp.*` | **~9.6k** distinct servers | **works today** (the bridge) | seed `mcpConfig` into the canonical CLI run path (the `cli/run.ts:375` gap, §5) + mirror `GET /v0.1/servers` into a `~/.piflow` catalog |
| 2 | **Skills — Anthropic + curated** | `node.skill` | ~1.5k–4k curated | **works today** (pi discovers `SKILL.md` / agentskills.io) | stage `node.skill` folders into a pi-discoverable skills path |
| 3 | MCP — Glama/PulseMCP/Smithery enrichment | `mcp.*` | 18k+ curated | works today | add useCount + security fields to the catalog for ranking |
| … | **OpenClaw `oc.*`** | `oc.*` | community, real | **needs-build** | per-plugin packing + provision the reserved `openclaw` server |

**The single highest-leverage unlock:** seed `mcpConfig`/the catalog into the canonical run path — the SAME
`cli/run.ts:375` gap that blocks `oc.*` — which lights up the ~9.6k MCP universe **and** the `oc.*` lane at once.

**Per-node equipping (Thread B) is a seam that already exists:** `ToolRegistry.search()` (`types.ts:721`) over a
mirrored capability catalog → emit `node.tools.allow` + `node.skill` (`types.ts:29`) + `node.mcp.servers`
(`types.ts:848`), or one `agentType` preset flattened by `mergePreset` at author time. Designing a node =
searching this universe and picking.

---

## References
- **Deep architecture verdict (OpenClaw):** `docs/research/openclaw-localhost-gateway-deep-dive.md`
- **Node authoring surface (companion):** `docs/design/node-action-protocol.md` (G11/G12/G13)
- **Sourcing/ingest + acquisition:** `docs/research/openclaw-plugin-sourcing-2026-06-21.md`
- **pi↔OpenClaw relation:** `docs/research/pi-tools-extensions-openclaw-2026-06-21.md`
- **`-e` delivery / secrets:** `docs/research/tool-bridge-delivery-2026-06-21.md`, `…/tool-bridge-env-2026-06-21.md`
- **Substrate (the host):** `docs/design/openclaw-substrate-adoption.md` · **Cloud:** `docs/design/cloud-tool-gateway-architecture.md`
- **The full-loop spike:** `docs/research/spike-full-plugin-loop.md`

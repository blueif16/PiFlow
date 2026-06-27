# Capability Catalog — ONLINE index + LOCAL download-cache (the package-manager pattern for piflow)

> **What this is.** The decisive design for how piflow MAINTAINS its capability catalog — the searchable
> universe of installable tools + skills across the three lanes (MCP / OpenClaw / Skills) — under one hard
> constraint: **the catalog is ONLINE, never bundled into the SDK; locally we keep only what we actually
> download/install.** This BUILDS ON the settled prior research (it does NOT re-survey it) and obeys the
> CLAUDE.md data boundary (the SDK is product-agnostic; the catalog DATA + cache live in `~/.piflow/`).
>
> **Builds on (cited, not re-derived):**
> - MCP-registry mechanics — `docs/research/tool-registry-maintenance-2026-06-21.md` (SETTLED: index-not-mirror,
>   `updated_since` incremental pull, tombstones, namespace+ownership trust, the active/deprecated/deleted state
>   machine). Cited throughout; NOT re-surveyed.
> - The sources + counts — `docs/research/tool-skill-ecosystem-landscape.md` (MCP ~9.6k, skills, ClawHub).
> - OpenClaw sourcing — `docs/research/openclaw-plugin-sourcing-2026-06-21.md` (enumerate + the packing step).
> - The lanes + the live-path gap — `docs/design/tool-calling-architecture.md` (`cli/run.ts:375` seeds no `mcpConfig`).
>
> **Confidence:** `[PRIOR]` = settled in a cited prior brief · `[EXA]` = confirmed live via Exa (URL inline) ·
> `[GROUND]` = in-repo `file:line` · `[SYNTH]` = this doc's recommendation · `[UNVERIFIED]` = not confirmed (URL to check).
> Last written 2026-06-26.

---

## 1. Verdict — online index + local download-cache: **YES**

**Decision (not a maybe): keep the catalog ONLINE and download to local ONLY what a run installs.** This is
exactly how every mature package ecosystem already works — the *index* is an online service, the *artifact* is
fetched on install and then kept locally:

- **npm** — metadata API `GET /:package` is online; `npm install` fetches the tarball into local
  `node_modules` + pins it in a lockfile. `[PRIOR]` (registry-maintenance §1B).
- **MCP Official Registry** — is itself **an index, not a mirror**: it hosts `server.json` pointers; the code
  lives on npm/PyPI/Docker and is fetched only when you run the server. `[PRIOR]` (registry-maintenance §1A:24-45).
- **Homebrew** — the formula index ships with the client; bottles download on `brew install`. `[SYNTH]`

So a ~9.6k-entry MCP catalog (plus skills + OpenClaw) does **not** belong baked into `@piflow/core`. The SDK
ships a **catalog CLIENT** (queries online, manages the `~/.piflow` cache); the catalog DATA is online + a
locally-cached **index slice** for offline search; the **artifact** (an npm/PyPI/Docker MCP server, an OpenClaw
pack, a `SKILL.md` folder) lands under `~/.piflow/` only when a node installs it. The owner's model is correct.
This doc makes it concrete and settles the one real decision below.

---

## 2. THE decision — federate vs host-our-own vs hybrid

### The three options

| | **(A) Federate** | **(B) Host-our-own** | **(C) Thin hybrid** |
|---|---|---|---|
| **Shape** | Query upstream registries directly / at-refresh (MCP `GET /v0.1/servers`, ClawHub `GET /api/v1/packages`, agent-skills `.well-known` index); cache a local index slice. No piflow service. | piflow runs an aggregated online catalog service that pre-merges + curates + ranks + security-gates across all sources; the SDK queries it. | A thin piflow index/CDN that federates upstream, layers ranking/security/dedup where upstream lacks it, SDK caches it. |
| **Ops cost** | **None** — no piflow service to run, secure, scale, or pay for. Refresh is client-side. | **High** — a 24/7 service: ingest pipeline, DB, scanning fleet (Glama-class is "1M+ scans/yr" `[PRIOR]`), uptime, on-call. | **Medium** — a stateless-ish CDN + a periodic merge job, but still a service piflow owns + secures. |
| **Freshness** | **Best** — reads upstream at refresh; `updated_since` incremental pull means tombstones + bumps propagate the moment upstream publishes `[EXA]`. | Lags by the ingest cycle; we become a stale mirror of mirrors (the "32.8%-stale directory" failure `[PRIOR]`). | Lags by the merge cadence; better than (B) if the merge just re-federates. |
| **Offline** | Cached index slice in `~/.piflow/` → search works offline; install needs net (same as npm). | Same offline story, but the cache now depends on OUR uptime to refill. | Same as (A) for the cache; refill depends on our CDN. |
| **Curation / ranking / security** | Inherit upstream's: MCP registry's status state-machine + namespace proof `[PRIOR]`; **ClawHub already ships `sort=recommended\|trending\|downloads` + a per-version `/security` endpoint** `[EXA]`; PulseMCP/Glama expose popularity+security as *enrichment* APIs `[PRIOR]`. piflow layers a thin local policy on top. | Maximal control — we own TDQS-style scoring, our own malware gate. But we'd be **rebuilding Glama/PulseMCP**, who already do it. | Add only the *missing* signal (e.g. cross-source dedup, a unified rank) on top of upstream. |
| **SDK product-agnostic fit** | **Best** — the SDK ships only a CLIENT (URLs + a query/cache layer = logic); zero product data, zero piflow-hosted dependency. Obeys CLAUDE.md cleanly. | **Worst** — a piflow service is a product dependency the SDK now needs at runtime; couples the "logic-only SDK" to our infra. | Middle — the SDK still talks to a piflow URL, so there's a soft product coupling, but no curated DATA in the SDK. |

### Recommendation — **(A) Federate now, with a thin LOCAL enrichment layer; defer (C) until upstream demonstrably can't rank** `[SYNTH]`

**Federate** for all three lanes. Reasons, in order:

1. **Every upstream already exposes a query + refresh API**, so federation is the package-manager-canonical
   path with the lowest ops cost and the best freshness:
   - **MCP** — `GET /v0.1/servers?updated_since=<RFC3339>&version=latest`, cursor-paginated, `include_deleted`
     auto-true on `updated_since` (tombstones), substring `search` — confirmed live `[EXA: github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/official-registry-api.md;
     modelcontextprotocol.io/registry/registry-aggregators]`, mechanics SETTLED `[PRIOR §1A]`.
   - **OpenClaw** — `GET /api/v1/packages` (filter `family`/`channel`/`capabilityTag`/`executesCode`/`category`,
     `cursor`), `GET /api/v1/packages/search?q=`, per-version `…/security` + `…/artifact/download`, and
     `sort=recommended|trending|downloads` — all confirmed live `[EXA: docs.openclaw.ai/clawhub/http-api;
     docs.openclaw.ai/clawhub/api]`.
   - **Skills** — agentskills.io is the open `SKILL.md` standard `[EXA: agentskills.io/specification]`, and the
     Cloudflare-led discovery RFC publishes a `.well-known/agent-skills/index.json` (per-entry `name`/`type`/
     `description`/`url`/`sha256`) so a curated set is fetchable, hash-verified, no scrape `[EXA:
     github.com/cloudflare/agent-skills-discovery-rfc; specification.website/spec/agent-readiness/agent-skills-discovery]`.

2. **The OpenClaw-needs-a-hybrid hypothesis FAILS on inspection.** The GO posed: maybe host a thin index where
   upstream lacks ranking/security — "e.g. OpenClaw/ClawHub." But ClawHub **already** ranks
   (`sort=recommended|trending|downloads`) **and** serves a per-version security report (`…/security`) `[EXA]`.
   So there is no upstream-ranking gap to fill for OpenClaw — federating ClawHub gets us ranking + security for
   free. The genuine OpenClaw gap is **acquisition/packaging** (no clean per-plugin npm packages — the
   piflow-side packing step) `[PRIOR: sourcing brief; tool-calling-architecture §4]`, which is a LOCAL install
   concern (§3/§4), **not** a reason to host an online index.

3. **Host-our-own (B) re-builds Glama/PulseMCP** (the active-scanner subregistries) and saddles the
   product-agnostic SDK with a runtime dependency on piflow infra — the worst SDK-boundary fit, the highest ops
   cost, and the worst freshness (a mirror-of-mirrors goes stale — the exact "green check on a 6-month-dead
   tool" failure the prior brief indicts) `[PRIOR §1C, §2.2]`. Rejected.

**What piflow DOES own (the thin LOCAL enrichment layer, NOT a hosted service):** dedup-by-repo across sources,
a unified local rank, and a trust GATE at install time — all computed **client-side over the cached index
slice**, persisted in `~/.piflow/`. This is logic in the SDK client + data in `~/.piflow/`, so it stays
product-agnostic. Promote to a **thin hybrid (C)** ONLY if a future need appears that upstream genuinely can't
serve (e.g. cross-source semantic ranking at a scale a client can't compute) — a documented later increment,
not now.

> **One-line answer:** **Federate** the three upstream registries (each already has a query + refresh API),
> cache an index slice locally, and add ranking/security/dedup as a CLIENT-SIDE layer over the cache — no
> piflow-hosted catalog service.

---

## 3. The online / local split, per lane

The **index is online** (with a cached slice for offline search); the **artifact is downloaded to local only on
install**. Per lane:

| Lane | ONLINE (index source + query/refresh API) | DOWNLOADED-TO-LOCAL on install (and where in `~/.piflow/`) |
|---|---|---|
| **MCP** (`mcp.<server>:<tool>`) | **MCP Official Registry** — `GET /v0.1/servers?updated_since=<RFC3339>&version=latest` (cursor-paginated; `include_deleted` auto-true; substring `search`) `[EXA, PRIOR §1A]`. Optional enrichment: PulseMCP/Glama popularity+security `[PRIOR]`. Registry stores `server.json` POINTERS, not the code. | The **server's package** — `npx -y <pkg>` / `uvx <pkg>` / `docker pull <image>` — fetched by the host into the MCP runtime cache when a node first selects the server; the resolved `server.json` config + its captured `tools/list` schema cached as an index row. Lives under **`~/.piflow/mcp/<server>@<ver>/`** (server install/cache) + the staged `_pi/mcp.json` per run `[GROUND: runner stages it, tool-calling-architecture §2 lane 4]`. |
| **OpenClaw** (`oc.<plugin>:<tool>`) | **ClawHub** — `GET /api/v1/packages?family=code-plugin&channel=…&capabilityTag=…` + `…/search?q=`, per-version `…/security`, `sort=recommended\|trending\|downloads` `[EXA]`. Names-only manifest ⇒ schema needs the capture-shim at install `[PRIOR: sourcing brief Coverage 3]`. | A **self-contained per-plugin pack** (the piflow packing step — `…/security` + `…/artifact/download` give the artifact; esbuild emits a standalone pack) into **`~/.piflow/extensions/<id>@<ver>/`** (its own `node_modules`) `[PRIOR: tool-calling-architecture §4 step 3, spike-full-plugin-loop §"install-location verdict"]`. |
| **Skills** (`node.skill`) | **agentskills.io** open standard + the Cloudflare `.well-known/agent-skills/index.json` discovery RFC (per-entry `name`/`type`/`description`/`url`/`sha256`) `[EXA]`; a curated set (Anthropic `anthropics/skills`, VoltAgent) as named sources `[PRIOR]`. Index entries are tiny (~100-token metadata). | The **`SKILL.md` folder** (+ `scripts/`/`references/`/`assets/`), `type:skill-md` single file or `type:archive`, SHA-256-verified against the index `digest` `[EXA]`, into **`~/.piflow/skills/<id>/`**, then staged into a pi-discoverable skills path per run (`--skill`) `[PRIOR: landscape §4a, pi is the loader]`. |

**The invariant:** what's online is the *index* (pointers + metadata + the cached slice for search); what lands
locally is the *artifact* a run actually installs, plus a pin. Search never needs net (it reads the cached
slice); install needs net (it fetches the artifact). Identical to npm.

---

## 4. The `~/.piflow/` layout

Mirrors the CLAUDE.md convention — `~/.piflow/` already holds `products.json` (registered repos) and
`index.json` (the run snapshot) `[GROUND: observe/registry.ts:37-45]`, overridable via `PIFLOW_HOME`
`[GROUND: observe/registry.ts:33]`. The catalog adds a sibling `catalog/` tree + per-lane install dirs. **Nothing
here goes in the SDK or the repo** — the SDK ships only the client that reads/writes these paths.

```
~/.piflow/                                  # globalDir() — observe/registry.ts:33 (PIFLOW_HOME override)
├── products.json                           # EXISTING — registered repo roots (observe/registry.ts:38)
├── index.json                              # EXISTING — run snapshot (observe/registry.ts:43)
│
├── catalog/                                # NEW — the cached ONLINE index slice (for offline search)
│   ├── mcp.index.json                      #   MCP rows: ToolEntry[] from server.json + tools/list, per-server pin
│   ├── openclaw.index.json                 #   ClawHub rows: skeleton ToolEntry[] (names-only manifest)
│   ├── skills.index.json                   #   skill rows: {name, description, url, digest} from the .well-known index
│   └── sync.json                           #   refresh state: per-source { lastUpdatedSince, etag, fetchedAt, ttl }
│
├── mcp/                                     # NEW — downloaded MCP server installs/caches (artifact, on install)
│   └── <server>@<ver>/                      #   the resolved server.json + captured tools/list schema + runtime cache
│
├── extensions/                             # NEW — downloaded OpenClaw per-plugin packs (artifact, on install)
│   └── <id>@<ver>/                          #   self-contained pack + its OWN node_modules (spike-full-plugin-loop verdict)
│
├── skills/                                 # NEW — downloaded skill folders (artifact, on install)
│   └── <id>/                                #   SKILL.md (+ scripts/ references/ assets/), SHA-256-verified
│
└── catalog.lock.json                       # NEW — the PIN/LOCK file: every installed id → { version, integrity(sha256),
                                            #   origin.ref, source, status, installedAt }. The reproducibility record.
```

**File shapes.**

`catalog/mcp.index.json` — an array of `ToolEntry` `[GROUND: types.ts:672-686]`, one per server-tool, exactly the
shape `mcpToolsToEntries` already emits `[GROUND: ingest.ts:38-52]`:
```jsonc
[{ "address": "mcp.github:create_issue", "source": "mcp", "piName": "github_create_issue",
   "description": "Create a GitHub issue.", "tags": ["vcs"], "parameters": { /* JSON Schema verbatim */ },
   "origin": { "kind": "mcp-server", "ref": "io.github.github/github-mcp-server" } }]
```

`catalog/openclaw.index.json` — skeleton `ToolEntry[]` exactly as `openClawPluginToEntries` emits (names-only,
`description:''`, `parameters` omitted, git/npm `origin.ref` pin) `[GROUND: ingest.ts:90-105, openclaw-community.ts]`.

`catalog/skills.index.json` — `[{ name, description, url, digest:"sha256:…", type:"skill-md"|"archive" }]`,
mapped from the `.well-known/agent-skills/index.json` entries `[EXA]`.

`catalog/sync.json` — `{ "<source>": { "lastUpdatedSince": "<RFC3339>", "etag": "…", "fetchedAt": "…", "ttlSeconds": N } }`
— the cursor for the next incremental pull (§5).

`catalog.lock.json` — the pin record, one row per installed artifact:
```jsonc
{ "mcp.github": { "version": "1.4.0", "integrity": "sha256:…", "origin": "io.github.github/github-mcp-server",
                  "source": "mcp", "status": "active", "installedAt": "2026-06-26T…" } }
```

**Maps to the existing seams.** The cached `*.index.json` rows are loaded into a `DefaultToolRegistry` exactly as
`loadCatalog()` loads the in-code seed today `[GROUND: catalog.ts:46-60]` — the in-code `OPENCLAW_SEED_CATALOG`
remains only the tiny *executable reference seed* (`oc.calc:add`); the *bulk* moves online → `~/.piflow/catalog/`.
The pin/lock parallels `origin.ref` already on every entry `[GROUND: types.ts:685]` and the `OPENCLAW_PIN`
convention `[GROUND: openclaw-community.ts:31]`.

---

## 5. Freshness · offline · provenance/security

The prior brief did the SURVEY of mechanisms `[PRIOR §2.2, §2.5, §3]`; this section pins the **piflow policy**.

**Refresh loop (incremental, never a full crawl).** Per source, the client does an `updated_since` pull and
advances the cursor in `catalog/sync.json`:
- **MCP** — `GET /v0.1/servers?updated_since=<sync.lastUpdatedSince>&version=latest`, follow `nextCursor` to
  exhaustion; `include_deleted` is auto-true so **tombstones arrive** (a `deleted` upstream → mark the row
  `status:'deleted'`); upsert each into `mcp.index.json`; set `lastUpdatedSince = now` `[EXA, PRIOR §1A:42-45]`.
- **OpenClaw** — `GET /api/v1/packages?family=code-plugin&channel=community&sort=updated&cursor=…`, paginate;
  filter to tool-bearing manifests (`contracts.tools`) `[PRIOR: landscape §3a]`. `[UNVERIFIED: whether ClawHub's
  `sort=updated` exposes a true `updated_since` delta cursor vs. only an ordering — check
  docs.openclaw.ai/clawhub/http-api; if delta-cursor absent, fall back to a full paginate + diff against the
  cached slice.]`
- **Skills** — re-fetch the `.well-known/agent-skills/index.json` of each curated source; a changed `digest` ⇒
  re-download on next install `[EXA]`.

**TTL.** Each `sync.json` row carries `ttlSeconds` (default 24h). A `search()`/`resolve()` that finds the slice
older than TTL triggers a **background** refresh and **serves the stale slice immediately** (never blocks a run
on a network call) — the npm "offline-first, refresh-behind" posture.

**Offline behavior.** Search/discover read **only** the cached `~/.piflow/catalog/*.index.json` → fully offline.
**Install requires net** (must fetch the artifact) — identical to `npm install` offline. A run that selects an
already-installed (locked) tool runs fully offline (the artifact is already under `~/.piflow/{mcp,extensions,skills}/`).

**Provenance / pinning.** Resolve at a **pin, not a floating tag** `[PRIOR §2.4]`: every install writes
`{version, integrity:sha256, origin}` to `catalog.lock.json`; re-install verifies the `integrity` hash (skills
already ship a `digest` to verify against `[EXA]`; MCP/OpenClaw pin by version + computed sha256). The lock makes
a run reproducible.

**Deprecation / tombstones.** Honour the MCP state machine `[PRIOR §1A:38-41]`: `deprecated` rows stay in the
slice + search **with a warning** (surface `deprecation.replacedBy` to the design agent); `deleted` rows are
hidden from default search and **refused at install/resolve** (`resolve()` already throws on an unknown/absent
address `[GROUND: registry.ts:82]` — extend it to refuse `status:'deleted'`).

**Trust gate (cite the prior brief; do not re-survey).** Before an `mcp`/`oc` artifact is wired into an agent,
apply the prior brief's layered gate `[PRIOR §2.5]`: (1) provenance — namespace/ownership proof (MCP DNS/OIDC),
package-↔-repo match, attestation if present; ClawHub's per-version `…/security` report feeds this `[EXA]`;
(2) introspect-in-sandbox once (run `tools/list` / capture-shim) to confirm declared == real schema; (3)
CVE/staleness flag. Unverified community tools → not wired without explicit operator opt-in. **The gate is
client-side policy over the federated metadata — piflow runs no scanner of its own** (Glama/PulseMCP already do).

---

## 6. SDK-boundary fit + the seam

**The SDK ships only the CLIENT, never the catalog data.** Concretely the SDK ships:
1. a **catalog client** that (a) queries the three online registries, (b) maintains the `~/.piflow/catalog/`
   slice + the per-lane install dirs + `catalog.lock.json`, and (c) feeds rows into a `DefaultToolRegistry`;
2. the existing pure transforms (`mcpToolsToEntries`, `openClawPluginToEntries`) that turn a fetched listing into
   `ToolEntry[]` `[GROUND: ingest.ts]`;
3. the existing `ToolRegistry.search()` / `resolve()` surface `[GROUND: types.ts:718-724]`.

The catalog **DATA** is online + `~/.piflow/` — **never** in `packages/*` or the GUI (the CLAUDE.md hard
boundary). This is the same split the SDK already honours: `observe/registry.ts` ships the *logic* to read/write
`~/.piflow/products.json`+`index.json`, never the products' data `[GROUND: observe/registry.ts:1-12]`.

**Where the client lives + how it feeds the run path.** The seam is **already built** — the catalog client is the
host-side feeder for `assembleRunTools`, which is the ONE pure builder that seeds the registry + `mcpConfig` into
the canonical run path `[GROUND: runner/tool-config.ts:60-73]`:

- `assembleRunTools({ spec, extraEntries, mcpListings })` already takes **`extraEntries: ToolEntry[]`** and
  **`mcpListings: Record<server, McpToolListing[]>`** as host inputs and is explicitly **pure — "the caller owns
  any actual MCP `tools/list` fetch"** `[GROUND: tool-config.ts:20-23, 30-42]`. **The catalog client IS that
  caller:** it reads the cached `~/.piflow/catalog/*.index.json` slice (refreshing per §5) and passes the rows in
  as `extraEntries` (for `oc.*`/skill rows) and `mcpListings` (for `mcp.*` rows), so a node selecting
  `mcp.*`/`oc.*` BINDS instead of falling through to a bare `DefaultToolRegistry`.
- `resolveRunTools` already wires `assembleRunTools` into BOTH canonical entries —
  `runFromTemplate` (the `piflowctl run` path) and `runFromConfig` `[GROUND: runner/entry.ts:34-43, 109-113,
  170-182]` — with an explicit-caller-wins guard, so a library consumer that built its own registry keeps control.
- **The single change to light up the online catalog:** have `resolveRunTools` (when the caller passed no
  registry) call the catalog client to load the cached slice + fetch listings, then hand them to
  `assembleRunTools` as `extraEntries`/`mcpListings`. This closes the SAME `cli/run.ts:375` live-path gap the
  prior design names — the seed of `mcpConfig`/catalog into the canonical run path
  `[GROUND: tool-calling-architecture §5; runner/entry.ts:170-182]` — now sourced from the ONLINE catalog +
  `~/.piflow/` cache instead of the tiny in-code seed.

Net: the SDK = client + transforms + `search`/`resolve` (logic). The catalog = online + `~/.piflow/` (data). They
meet at the `assembleRunTools` `extraEntries`/`mcpListings` seam, which already exists and is already on the
canonical run path. No new architecture — a catalog client that fills inputs the run path already accepts.

---

## Bar Audit

| Criterion | PASS/FAIL | Evidence |
|---|---|---|
| 1. External claims EXA-cited or UNVERIFIED; MCP-registry mechanics CITED from prior brief, not re-surveyed | **PASS** | MCP `updated_since`/cursor/tombstone `[EXA: official-registry-api.md + registry-aggregators]` + `[PRIOR §1A]`; ClawHub filters/security/sort `[EXA: docs.openclaw.ai/clawhub/http-api+api]`; skills `.well-known` RFC `[EXA: agentskills.io + cloudflare RFC]`; §5 OpenClaw delta-cursor marked `[UNVERIFIED]` w/ URL. MCP internals cited `[PRIOR]`, never re-derived. |
| 2. §2 makes a clear federate/host/hybrid RECOMMENDATION with reasons, not a survey | **PASS** | §2 = 3-option table (ops·freshness·offline·curation/security·SDK-fit) + a decisive **Federate** recommendation with 3 ordered reasons; the OpenClaw-hybrid hypothesis explicitly TESTED + rejected (ClawHub already ranks+security `[EXA]`); (B) rejected; (C) deferred. |
| 3. §3+§4 give a CONCRETE online/local split + real `~/.piflow/` paths/file-shapes, obeying the SDK boundary | **PASS** | §3 per-lane table (online index API vs downloaded artifact + dir); §4 concrete tree + 4 file-shapes w/ JSON; all under `~/.piflow/`, none in `packages/*`/GUI; mapped to `observe/registry.ts` + `loadCatalog` + `origin.ref`. |
| 4. §6 ties to the real seams (`observe/registry.ts`, `ToolRegistry.search` `types.ts:721`, the `cli/run.ts:375` seed) | **PASS** | §6 cites `observe/registry.ts:1-12/33`, `ToolRegistry.search/resolve` `types.ts:718-724`, `assembleRunTools` `tool-config.ts:60-73` (the `extraEntries`/`mcpListings` pure seam), `resolveRunTools` `entry.ts:34-43/170-182`, and the `cli/run.ts:375` live-path gap. |
| 5. Verdict (§1) states it as a decision (npm/MCP-registry/Homebrew pattern), not a maybe | **PASS** | §1 = "YES" decision + the one-line why (index online, artifacts on install) w/ npm/MCP-registry/Homebrew precedents. |
| 6. Design file written | **PASS** | this file: `docs/design/capability-catalog.md`. |

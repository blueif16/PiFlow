# Tool-registry MAINTENANCE for Pi Flow — research brief (2026-06-21)

How to **maintain** the Pi Flow `ToolRegistry` over time across two roadmap scopes: **M2** (compile
`sdk`/`mcp` addresses into a runtime `-e` extension + `--tools`, conflict-guard, version/update) and **M4**
(a persisted, searchable, community-ingesting catalog kept fresh / deduped / trustworthy).

Builds ON `docs/research/pi-tools-extensions-openclaw-2026-06-21.md` (the `namespace:name` model, pi
`registerTool` fields, "pi has no native MCP bridge"). Those findings are **settled** — this brief does NOT
re-derive the addressing scheme; it covers registry *upkeep*.

**Research legs run: Exa (web/advanced) + Reddit (apify `macrocosmos/reddit-scraper`, r/mcp). No YouTube.**
Reddit succeeded (15 r/mcp posts, dataset `dSyBSalOzNjOr1OEt`).

**Confidence legend:** `[PRIMARY]` = vendor/registry docs or source · `[SECONDARY]` = third-party write-up /
audit · `[REDDIT]` = practitioner sentiment (anecdotal, directional) · `[SYNTH]` = our recommendation ·
`[UNVERIFIED]` = could not confirm from a primary source.

---

## 1. SURVEY — how mature tool/plugin registries are maintained

### 1A. MCP registry ecosystem

**Official MCP Registry** (`registry.modelcontextprotocol.io`, repo `modelcontextprotocol/registry`, Go,
~7k★, API freeze v0.1) `[PRIMARY]`:
- **Metadata schema = `server.json`** (`docs/reference/server-json/generic-server-json.md`): `name`
  (reverse-DNS unique id, e.g. `io.github.user/server-name`), `title`, `description`, `version`,
  `repository{url,source,id}`, `websiteUrl`, and **`packages[]`** (each: `registryType` npm|pypi|nuget|cargo|oci|mcpb,
  `registryBaseUrl`, `identifier`, `version`, `transport`, `environmentVariables[]{name,description,isRequired,isSecret}`)
  or **`remotes[]`** (`type` streamable-http, `url`). Plus `_meta."io.modelcontextprotocol.registry/publisher-provided"`.
- **Ingestion = PUSH (publish API), not crawl.** Server creators publish their own `server.json`. The registry
  hosts **metadata that points at packages** (npm/PyPI/Docker host the code); it is an index, not a mirror.
  `[PRIMARY]` (registry/about.md).
- **Trust = namespace + ownership proof.** Namespace via **DNS or GitHub OIDC** ("to publish `com.example/server`
  prove you own `example.com`"); **package-ownership verification** (publisher must prove control of the npm/PyPI
  package); **restricted registry base URLs** (npmjs.org, pypi.org, crates.io, ghcr.io… only — no private mirrors);
  `_meta` restricted to the `publisher-provided` key. `[PRIMARY]` (official-registry-requirements.md).
- **Versioning + deprecation = explicit status state-machine.** `PATCH /servers/{name}/versions/{version}/status`
  with `status ∈ {active, deprecated, deleted}` + `statusMessage` (≤500 chars). `deprecated` = still visible **with a
  warning**; `deleted` = hidden from default listings. Per-version *and* all-versions transitions. `[PRIMARY]`
  (official-registry-api.md).
- **Sync model for downstreams = incremental pull via `updated_since`.** `GET /v0.1/servers?updated_since=<RFC3339>&version=latest`,
  cursor-paginated; **`include_deleted` auto-true when `updated_since` is set** so a mirror learns about
  *tombstones*, not just additions. `search` = "intentionally simple" case-insensitive substring on names — "for
  advanced searching, use a subregistry." `[PRIMARY]` This is the canonical **registry-as-API mirror** pattern.

**Aggregators / subregistries** (they *consume* the official registry and layer enrichment on top):
- **Glama** `[PRIMARY]` (glama.ai/mcp/methodology) — the most aggressive maintenance pipeline; a worked model
  for "registry as active scanner, not passive directory" (1M+ scans/yr):
  1. **Maintainer verification** (GitHub OAuth, write/admin proof). 2. **Continuous source sync** (clones full git
  history; reflects pushes "within minutes"; every tag/commit retained). 3. **Sandboxed build+run on Firecracker
  microVMs** (ephemeral fs/network; AI-inferred Dockerfile if none; **if build fails, the listing is withheld from
  search/recommendations** — only reproducible builds become discoverable). 4. **Protocol introspection** —
  actually runs `tools/list` / `resources/list` / `prompts/list`, captures full JSON-Schema + MCP annotation hints
  (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). 5. **Behavioural analysis** at
  syscall/network layer (credential-path access, unexpected outbound hosts, exfil signatures, forks, out-of-dir
  writes) → two-level malicious/anomalous classification. 6. **Scoring** = "Tool Definition Quality Score (TDQS)"
  per tool + tool-set coherence + server cohesiveness. Every entry carries **5 machine-verifiable signals**: full
  captured schema, quality scores, behavioural profile, **change history (schema + behaviour drift)**, and a
  **`last-scanned` timestamp (data-freshness)**.
- **Smithery** `[PRIMARY]` (smithery.mintlify.dev/docs/build/publish) — **URL publish + auto-scan**: you submit a
  public HTTPS (streamable-HTTP) URL, Smithery's gateway proxies upstream and **scans the live server to extract
  tools/prompts/resources** for the server page. Auth-required servers prompt for OAuth so the scan can complete; if
  scanning can't run, a **static `/.well-known/mcp/server-card.json`** supplies metadata manually. Pattern =
  **introspect-the-running-server**, with a static-card fallback.
- **PulseMCP / mcp.so / Glama** as directories `[SECONDARY]` (automationswitch, useloadout, callsphere): PulseMCP
  ~11.8–17k servers, **hand-reviewed daily**, "freshness + review"; mcp.so ~19.7k **community-submitted, flat,
  breadth-over-curation**; Glama ~21k **automated+community, daily**. **Key distinction (settled):** *directories*
  are human-browsable; the *registry* is the machine-readable API for programmatic discovery; *meta-indexes*
  aggregate. PulseMCP exposes `Classification ∈ {official, reference, community}` and popularity ("Est Visitors /
  week") as rank signals `[PRIMARY-ish]` (pulsemcp.com/servers).

### 1B. Package / extension registries

- **npm** `[PRIMARY]` (npm/registry, npm/provenance, github.blog): **pull metadata API** (`GET /:package`, full vs
  abbreviated `application/vnd.npm.install-v1+json`); versions under `versions{}`, mutable **`dist-tags`**
  (`latest`, `next`…) as the human-facing pointer; **`deprecated` is a per-version string field** (soft, warns on
  install, never deletes). **Provenance = Sigstore + SLSA**: publish-time signed attestation linking artifact →
  source commit + CI build, logged to a public transparency ledger; consumers verify *where/how* a package was
  built. This is the **strongest "trust the artifact's origin" primitive** in the survey.
- **VS Code Marketplace** `[PRIMARY]` (developer.microsoft.com, 2025): **multi-stage malware defense** — (1) static
  scan on ingest (Defender-class), (2) **re-scan shortly after publish** (scanner DBs lag new patterns), (3)
  **periodic marketplace-wide bulk re-scans** (new attack vectors), (4) **dynamic/sandbox run-time detection**, (5)
  **community reporting**; flagged packages get **manual security-engineer review before removal** (false-positive
  guard). Lesson: **verification is continuous and repeated, not one-shot at submit.**
- **Hugging Face Hub** `[PRIMARY]` (huggingface.co/docs/hub/model-cards): metadata = **YAML front-matter in the
  repo's `README.md`** (license, tags, language, datasets, eval results) — **registry-as-code, co-located with the
  artifact** — that **directly powers faceted filter/search**. Discovery ranks on downloads + likes + tags. (HF also
  runs malware/secret scanning + gated models — `[UNVERIFIED]` exact pipeline, not fetched.)
- **n8n community nodes** `[PRIMARY]` (docs.n8n.io verification-guidelines; n8n-io/n8n source): **two-tier trust** —
  unverified community nodes (any npm package) vs **n8n-VERIFIED** (discoverable+installable in-product). Verified
  requires: the `n8n-node` CLI scaffold (forces required `package.json` metadata + lint to standards), **npm↔GitHub
  repo-URL + author match**, "exactly one third-party service per package, no proxy-for-many." Critically, the
  runtime enforces a **vetted-checksum gate**: `findVetted(name)?.checksum` — install **throws "Package … is not
  vetted for installation" if there's no known checksum** (community.n8n.io thread, source `community-packages`).
  **From 2026-05-01, all community nodes must publish via a GitHub Action with a provenance statement** — n8n is
  converging on the npm-provenance model. This `checksum`-gate is the single most directly-copyable mechanism for us.
- **LangChain Hub / LangSmith** `[PRIMARY]` (docs.langchain.com/langsmith/manage-prompts): prompts as
  **git-like commits** with **commit tags**, reserved **`staging`/`production` environment tags** (promotion model),
  prompt owners (access control), **webhook triggers on update**, and a **public hub** for community discovery.
  Lesson: **named-environment pins** (`production` tag) beat raw version pinning for "which one is wired right now."

### 1C. Maintenance pain points practitioners report `[REDDIT]` / `[SECONDARY]`

From r/mcp (dataset `dSyBSalOzNjOr1OEt`) and the awesomeagents audit — **these are the failure modes our design
must survive:**
- **Discovery-at-scale is the #1 pain.** "Hundreds of agents trying to find the right tool amongst thousands…
  new tools come up, old ones get taken down" (67↑/85 comments); "hardcoding works at 3-5 servers, breaks at 30"
  (10↑/25). Practitioners want a **central list + namespaces + versions**, not per-agent hardcoding.
- **Name collisions are real and break correctness.** Bifrost gateway (46↑): *"`search_files` from filesystem vs
  `search_files` from gdrive — LLM picks the wrong one."* Their fix = **namespaced/prefixed tools** (`filesystem.search_files`)
  — independently re-derives our `namespace:name` → prefixed-`piName` conflict guard.
- **Schema bloat.** "50 servers = 200+ tools dumped into every request → context blows up, cost+latency spike";
  fix = **dynamic per-agent tool filtering** ("virtual keys define which tools are available per workflow"). Echoes
  the prior brief's "MCP dumps all tool descriptions into context" and pi's no-MCP rationale.
- **Dead/stale servers.** Bifrost: *"MCP servers crash, hang, become unresponsive… we health-check before routing,
  exclude failed ones, retry periodically."* The **awesomeagents 2026 audit** `[SECONDARY]` quantifies it: of
  ~8,097 enriched repos, **32.8% had no commit in 180+ days, 13.7% in 365+ days; 405 "zombies" (50★ + 6mo stale)**;
  registries "grow by accretion — servers get listed, never delisted." Advice: **pin by commit hash not tag; check
  `pushed_at`; run `npm audit`/OSV before trusting at runtime.** ~1.4% of sampled packages carry a known CVE
  (a *floor*, not ceiling).
- **Trust of community tools.** "Trust no MCP server you haven't tested" (mcprated); mcp-shield / vigile-mcp /
  RNWY = a cottage industry of **third-party trust-scoring/scanning registries**, signalling the official directories
  don't surface enough trust data. useloadout: "~7,000-server analysis found many require no auth… picking by
  popularity alone is risky."

---

## 2. SYNTHESIZE — recommended registry-maintenance design for Pi Flow `[SYNTH]`

### 2.1 METADATA — fields to ADD to `ToolEntry`
Keep today's `{address, source, piName, description, tags?, parameters?, origin?}`; **add maintainability fields**
(modeled on `server.json` + npm provenance + Glama's freshness signals + n8n's checksum):

```ts
interface ToolEntry {
  // …existing…
  version?: string;                 // semver of the tool/plugin/server artifact (npm/pypi/git tag)
  pin?: { commit?: string; integrity?: string }; // commit hash + checksum/SRI — pin by HASH, not tag (audit advice)
  status?: 'active' | 'deprecated' | 'deleted'; // MCP-registry state machine; deprecated stays visible + warns
  deprecation?: { message: string; replacedBy?: ToolAddress }; // ≤500 chars, like statusMessage
  provenance?: {                    // npm/Sigstore + MCP namespace-auth model
    repository?: string;            // git URL  (npm↔repo match, n8n-style)
    publisher?: string;            // verified namespace owner (DNS/GitHub OIDC)
    attestation?: string;          // sigstore bundle ref / SLSA, if available
    verified: boolean;
  };
  trust?: { tier: 'builtin' | 'verified' | 'community'; score?: number; scannedBy?: string[] };
  health?: { lastVerified?: string; lastUpstreamCommit?: string; staleDays?: number; introspectOk?: boolean; cves?: string[] };
  popularity?: { downloads?: number; stars?: number; rank?: number }; // rank signal, NOT a trust proxy (audit warning)
  examples?: { input: unknown; output: unknown }[];  // helps both the design agent AND the model call it right
}
```
Rationale per field is the survey: `status`/`deprecation` = MCP state machine; `pin.integrity` = n8n's
**vetted-checksum gate** + audit's "pin by hash"; `provenance.verified` = npm Sigstore + MCP namespace-auth;
`health.lastVerified`/`staleDays`/`introspectOk` = Glama's `last-scanned` + the 32.8%-stale problem;
`trust.tier` = n8n verified/community split.

### 2.2 INGESTION + SYNC model
**Pull/mirror per source; never one giant crawl.** (matches MCP's `updated_since` mirror, npm's metadata API,
HF's repo-co-located cards):
- **`builtin`** — static, hand-curated in-repo (the 7 pi built-ins). No sync.
- **`sdk` (pi extensions / OpenClaw plugins)** — **pull from the package's manifest** (the OpenClaw `contracts.tools[]`
  manifest from the prior brief; pi extension's exported `registerTool` defs) at **a pinned version**; re-resolve
  on version bump. For OpenClaw, the manifest IS the metadata source — read it, don't run the plugin to discover.
- **`mcp` (MCP servers)** — **mirror the official MCP Registry via `GET /servers?updated_since=…&include_deleted=true`**
  (canonical, push-fed, namespace-verified) rather than crawling directories; **for the captured tool *schema*,
  introspect the running server** (`tools/list`, Smithery/Glama pattern) **inside our per-node sandbox** since the
  registry only stores pointers + declared metadata, not always live tool schemas. Optionally enrich rank from
  PulseMCP/Glama, but treat aggregator counts as noisy (audit: dedup-by-repo collapsed 17,320 rows → 11,447).
- **Freshness loop (the 32.8%-stale fix):** a scheduled **re-verify** job stamps `health.lastVerified`,
  recomputes `staleDays` from `lastUpstreamCommit`, re-runs `introspectOk`, re-checks OSV CVEs; **surface staleness
  in search, downrank/flag, never silently serve a green check on a 6-month-dead tool** (the audit's core
  indictment of the directories). Honour upstream **tombstones**: a `deleted` status from the MCP registry →
  mark our entry `deleted`.
- **Dedup + conflict policy across sources:**
  - **Identity key = `provenance.repository` + `version`** (audit's dedup-by-repo-URL), NOT the display name —
    npm/PyPI/git double-listings of one server collapse to one entry.
  - **`address` (`namespace:name`) is unique by construction** (author-facing). On a **`piName` (flat wire-name)
    collision** between two sources, the registry MUST disambiguate by **prefixing** (`<ns>_<name>`, the Bifrost +
    pi-mcp-adapter convention) — pi/OpenClaw both use a flat name-space with *skip-on-conflict*, which silently
    drops a tool, so **we resolve, not skip**. Precedence on a true duplicate: **builtin > verified-sdk >
    community-mcp**, higher `trust.score` wins, ties broken by `popularity.rank`; log the shadowed entry.

### 2.3 PERSISTENCE + SEARCH (M4)
- **Registry-as-code (git-tracked JSON), not a DB — at launch.** `[SYNTH]` The catalog is **thousands**, not
  millions, of entries; HF (YAML cards in-repo) and the MCP registry's reviewable model show git-tracked metadata is
  enough, and it gives **free history/diff/audit, PR-based curation, and provenance** (who added what, when) with no
  infra. Store one JSON per entry (or a sharded manifest) co-located with the resolver; the freshness job commits
  `health`/`status` updates (the git log *is* the change-history Glama keeps).
- **Search = keyword + tags + faceted filters FIRST; embeddings only when they earn it.** `[SYNTH]` The MCP
  registry itself ships only substring search and says "use a subregistry for advanced"; HF ranks on tags+downloads;
  n8n filters by category. For a few-thousand-entry catalog, **`tags` + `description` keyword + facets
  (`source`, `trust.tier`, `status`, freshness)** covers the design agent's "scope tools for an area → search → grab"
  loop. **Add semantic/embedding search only when** keyword recall demonstrably fails (synonymy: agent asks for
  "scrape a webpage", tool is tagged "crawl/fetch") — then embed `description+tags+examples` into a local vector
  index as a **secondary recall layer over the same git-JSON source of truth**, not a replacement DB. **Ranking
  signals (in order): trust.tier → status(active) → freshness(¬stale) → popularity → keyword score.** Popularity is
  a *tiebreaker, never a trust proxy* (audit's explicit warning).

### 2.4 RUNTIME COMPILE (M2)
Extends the prior brief's compile-to-`-e`+`--tools` seam with **maintenance discipline**:
- **Resolve at a PIN, not a floating tag.** `resolve(ToolSelection)` reads each entry's `version`+`pin.integrity`;
  the generated extension and any MCP/`npm`/`pip` fetch uses the **commit-hash/checksum pin** (audit advice;
  n8n checksum gate). Record the resolved pin in the run manifest so a run is reproducible.
- **Conflict-guard the flat pi name-space BEFORE emitting flags.** Resolver computes final `piName`s, asserts
  uniqueness, **prefixes on collision** (§2.2). Because pi *silently skips* conflicting names, the guard must run in
  our resolver and **fail loud** if it can't disambiguate — never hand pi two tools that map to one bare name.
- **Refuse to wire `status:'deleted'`; warn+allow `deprecated`** (surface `deprecation.replacedBy` to the design
  agent). Refuse (or require explicit override) when `provenance.verified=false` for an `mcp`/community source —
  this is the gate, see §2.5.
- **Versioning at resolve time:** a `ToolSelection` may pin `version`; absent a pin, resolve to the latest
  **`active`+verified** entry and stamp the chosen version. Re-resolving after an upstream bump is a registry
  re-sync (§2.2), not a pi concern.

### 2.5 TRUST / SECURITY before wiring a community tool into an agent
Layer the survey's mechanisms onto **our existing per-node sandbox** (sandbox internals owned elsewhere — we only
gate *which tools enter it*):
1. **Provenance gate (efficient, static):** require `provenance.verified` for `mcp`/community `sdk` tools — namespace
   ownership (MCP DNS/OIDC) + npm↔repo match (n8n) + Sigstore attestation if present. Unverified → `trust.tier:
   'community'`, **not wired without explicit operator opt-in.**
2. **Introspect-in-sandbox before trust (Glama/Smithery pattern):** first time a tool is ingested/wired, run its
   `tools/list` / load its extension **inside the per-node sandbox**, capture the real schema, diff against declared
   `parameters`; **build/introspect failure ⇒ withhold from search** (Glama's "no discoverability without a
   reproducible build").
3. **CVE + staleness gate:** check `health.cves` (OSV) and `staleDays`; flag/downrank, block high/critical CVE at
   wire time.
4. **Continuous, repeated re-verification (VS Code lesson):** trust is not one-shot at ingest — the freshness job
   re-scans on a schedule; a tool that drifts (schema/behaviour change) or goes stale is re-flagged.
5. **Honour MCP `destructiveHint`/`readOnlyHint` annotations** when surfacing a tool to the planner so a node can
   prefer read-only tools (out-of-scope to design here; just preserve the annotation in `ToolEntry`).

### 2.6 The line — M2 vs M4
- **M2 = RESOLVE → RUNTIME (compile a *selection* into a running pi).** Input: a `ToolSelection` of already-known
  addresses. Owns: `resolve()` → generated `-e` extension + `--tools`/`--exclude-tools`/`--no-builtin-tools`, the
  **flat-name conflict-guard**, **pin/version at resolve time**, refuse-`deleted`/warn-`deprecated`. **Stateless per
  run; consumes registry metadata, doesn't curate it.** Needs from §2.1 only: `piName`, `version`, `pin`, `status`.
- **M4 = CATALOG → MAINTENANCE (populate, persist, search, keep-fresh, trust).** Owns: **ingestion+sync** (§2.2),
  **persistence (git-JSON) + search/rank** (§2.3), **provenance/trust scoring + dedup** (§2.2/2.5), the
  **freshness/staleness loop**, and `search(query,…)`. **Stateful, scheduled, the durable store.** Produces the
  metadata M2 consumes.
- **Seam:** M4 owns *truth about tools*; M2 owns *turning a chosen subset into pi flags safely*. `register()` +
  `search()` are M4 surface; `resolve()` is the M2 surface. They meet at the enriched `ToolEntry`.

---

## 3. TOP-3 maintenance best-practices `[SYNTH]`
1. **Mirror via incremental `updated_since` pull + honour tombstones; never one-shot crawl.** Copy the MCP
   registry's downstream-sync contract (cursor + `include_deleted`) so additions, version bumps, AND deletions
   propagate — and run a **scheduled re-verify** that stamps `lastVerified`/`staleDays`/`introspectOk` so the
   32.8%-stale / "green check on a dead server" failure can't happen in our catalog.
2. **Pin + verify by hash, gate by provenance, before wiring.** Resolve at a **commit-hash/checksum pin** (n8n
   `findVetted().checksum`; audit "pin by hash not tag"), require namespace/repo/Sigstore **provenance** for
   community tools, and **introspect-in-sandbox once** (Glama/Smithery) to confirm declared == real schema before a
   tool is discoverable or wired.
3. **Resolve flat-name conflicts by prefixing — never let pi silently skip.** pi/OpenClaw use a flat name-space
   with skip-on-conflict (and r/mcp Bifrost confirms collisions make the LLM call the wrong tool); the registry must
   guarantee unique `piName`s via prefixing at resolve time and **fail loud** rather than drop.

**Flagged uncertainty:** Glama TDQS internals & exact malware ruleset are deliberately undisclosed `[PRIMARY,
partial]`; HF malware/gated-scanning pipeline `[UNVERIFIED]` (not fetched); the awesomeagents 32.8%-stale figure is
one third-party audit `[SECONDARY]`, directionally corroborated by Reddit but not independently reproduced; whether
the official MCP registry exposes live per-tool *schemas* vs only package pointers — it stores `server.json`
pointers, so **schema capture still needs our own introspection** `[PRIMARY-inferred]`.

---

## Appendix — sources (confidence-tagged)
**MCP registry** `[PRIMARY]`: github.com/modelcontextprotocol/registry — `docs/reference/server-json/{generic-server-json,official-registry-requirements}.md`,
`docs/reference/api/official-registry-api.md`; modelcontextprotocol.io/registry/about.md.
**Glama** `[PRIMARY]`: glama.ai/mcp/methodology. **Smithery** `[PRIMARY]`: smithery.mintlify.dev/docs/build/publish.
**npm** `[PRIMARY]`: github.com/npm/registry (package-metadata.md), docs.npmjs.com/generating-provenance-statements,
github.com/npm/provenance, github.blog/.../introducing-npm-package-provenance.
**VS Code** `[PRIMARY]`: developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace (2025).
**Hugging Face** `[PRIMARY]`: huggingface.co/docs/hub/model-cards.
**n8n** `[PRIMARY]`: docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/, .../deploy/submit-community-nodes/,
github.com/n8n-io/n8n (community-packages.service.ts), community.n8n.io/t/.../274041 (vetted-checksum gate).
**LangChain/LangSmith** `[PRIMARY]`: docs.langchain.com/langsmith/manage-prompts.
**Directories** `[SECONDARY]`: automationswitch.com/.../where-to-find-mcp-servers-2026, useloadout.com/blog/mcp-so-vs-pulsemcp,
pulsemcp.com/servers, callsphere/clawnewbie/skillful comparisons.
**Staleness/CVE audit** `[SECONDARY]`: awesomeagents.ai/news/mcp-marketplace-audit (32.8% stale, zombies, OSV CVEs).
**Reddit** `[REDDIT]`: r/mcp via apify `macrocosmos/reddit-scraper` (dataset `dSyBSalOzNjOr1OEt`) — posts
1kzaw1e (discovery@scale, 67↑), 1r262kx (Bifrost: namespacing/schema-bloat/health-check, 46↑), 1r0egn7 (discovery 30+),
1tdcjsd (mcprated "trust no server you haven't tested"), 1spdhq8 (mcp-shield), 1slb6ux (vigile-mcp).
**Builds on** `[GROUND]`: docs/research/pi-tools-extensions-openclaw-2026-06-21.md.

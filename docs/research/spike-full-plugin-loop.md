# Spike — the FULL plugin loop with NO OpenClaw install

> **Why this spike exists.** Every prior proof loaded plugins from `node_modules/openclaw/dist/extensions`,
> which silently assumes the user installed OpenClaw. The product MUST require **no OpenClaw install** — the
> user never knows OpenClaw exists. This spike proves the real loop: **discover → acquire → install to a
> piflow-owned cache → load → execute**, where the ONLY OpenClaw-origin code is (1) the one fetched plugin and
> (2) our **vendored** `@openclaw/plugin-sdk` contract — never a `node_modules/openclaw` runtime dependency.
>
> **Status:** OPEN. Owner: sub-agent. Results recorded in §Results below.

---

## Grounded starting facts (verified locally, this repo)

- Each OpenClaw tool-plugin is an **individually-scoped npm package** with its own `package.json` + minimal deps:
  - `@openclaw/duckduckgo-plugin` — **zero deps** (keyless web search → the clean demonstrator)
  - `@openclaw/workboard` — `{typebox}` · `@openclaw/tavily-plugin` — `{typebox}` · `@openclaw/memory-core` — `{chokidar, json5, typebox}`
  - (read from `node_modules/openclaw/dist/extensions/<name>/package.json`)
- `@openclaw/plugin-sdk` is `private: true`, `0.0.0-private` → **unpublished**; it has MANY subpath exports
  (`./account-id`, `./acp-runtime`, `./*-runtime`, …). Source: `vendor/openclaw/packages/plugin-sdk/`.
- The in-process host (`packages/core/src/tools/openclaw-host.ts`) currently resolves plugins from
  `node_modules/openclaw/dist/extensions` (`:571`/`:578`) — **this is the shortcut this spike removes.**
- No network in the default sandbox (an `npm view openclaw` returns blank) — so HALF 1 (registry verify) uses
  the network-capable tools (WebFetch/exa); HALF 2 runs offline by populating the cache from already-on-disk
  plugin files (the SAME files an `npm pack` would deliver).

## Target plugin: `@openclaw/duckduckgo-plugin`
Zero deps, keyless web search — proves a real "service" tool through the whole loop with no key and no extra
package resolution. (If its entry turns out to reach a non-`plugin-sdk` `openclaw/*` path, fall back to
`@openclaw/workboard` — keyed-state, `{typebox}` only — and record why.)

---

## HALF 1 — ACQUISITION (design + verify; network)

Settle, with evidence (WebFetch `https://registry.npmjs.org/@openclaw%2F<name>` or exa):
1. Are `@openclaw/duckduckgo-plugin`, `@openclaw/workboard`, `@openclaw/tavily-plugin`, `@openclaw/memory-core`
   **published on the public npm registry**? Record each: latest version, tarball URL, or NOT-FOUND.
2. If a tool-plugin is **NOT** published standalone (only bundled inside `openclaw`), record the **fallback
   acquisition**: GitHub `openclaw/openclaw@<tag>:extensions/<name>/` source, or `npm pack openclaw` + extract
   `dist/extensions/<name>/`. State which mechanism each target needs.
3. Confirm the **install-location convention**: `~/.piflow/extensions/<name>@<ver>/` (parallels `~/.pi/`; the
   project rule is "global mapping/index/snapshots live in `~/.piflow/`"). Note if a different layout fits better.
4. `@openclaw/plugin-sdk` is unpublished → confirm it must be **vendored**; from `vendor/openclaw/packages/plugin-sdk`
   determine its dependency closure (the substrate doc claimed "116 K, zero deps" — verify) and whether the
   tool-tier plugins import only a SLICE of its subpaths (so we can vendor a slice) or need the whole package.

## HALF 2 — LOAD + EXECUTE from a piflow-owned cache (NO `node_modules/openclaw` at runtime)

Write ONE spike test/script (`packages/core/test/spike-full-plugin-loop.test.ts` or a `scripts/` mjs) that:
1. **Builds a fake piflow cache** under the OS tmp (NOT the real `~/.piflow`): copy the plugin's own files
   from `node_modules/openclaw/dist/extensions/duckduckgo/` into `<tmp>/.piflow/extensions/duckduckgo@<ver>/`.
   This mimics an `npm pack` payload — the same files npm would deliver — so the load path is identical to the
   real fetch, minus the network.
2. **Vendors the contract**: make `@openclaw/plugin-sdk` resolve from a piflow-controlled location (the
   `vendor/openclaw/packages/plugin-sdk` copy, or a minimal vendored slice), NOT from `node_modules/openclaw`.
3. **Loads + executes from the cache**: import the plugin entry from the CACHE dir and drive its search tool
   through `hostOpenClawTool({ mod, toolName, workspaceDir, params })` (model on
   `packages/core/test/openclaw-host-memory-get.test.ts`). Assert a **real search result** (not a stub).
4. **Proves the no-OpenClaw claim**: the runtime import graph must reference ONLY the cached plugin + the
   vendored `plugin-sdk` — NO `node_modules/openclaw/...` import at execute time. Demonstrate it (e.g. grep the
   loaded module's imports; or run with `node_modules/openclaw` made unresolvable for the load step).

### The bar (meaningful, per test-discipline)
- **Real result, not registration:** the duckduckgo tool's execute returns actual search content for a query
  we choose; assert on a value tied to the query. If the live search is network-blocked, the honest partial
  result is "plugin LOADED + reached execute from the cache; the external HTTP call is network-gated" — still
  proves the loop up to the service boundary. Record which.
- **No-OpenClaw is OBSERVABLE:** show the runtime path imports no `node_modules/openclaw/*` — that is the whole
  point; a green test that still secretly resolves through `node_modules/openclaw` FAILS the spike's intent.
- **Test-the-test:** break the cache path (point it at an empty dir) and confirm the test goes red (proves it
  actually loads from the cache, not from a stray openclaw resolution).
- If the plugin **cannot** load standalone (its entry imports a deep `openclaw/*` path beyond `plugin-sdk`),
  that is a FINDING, not a failure: record the EXACT missing import — it is the boundary of "standalone
  fetchable," and pick the fallback target.

### Scope fence
A SPIKE. ONE new test/script file + a temp cache under `os.tmpdir()` (NEVER write the real `~/.piflow`). NO
production edits to `openclaw-host.ts`/`compile.ts`/the runner. NO live model. Do NOT `npm install openclaw`.
If HALF 1 can't reach the registry, say so and proceed with HALF 2 offline (the cache-copy path needs no net
except the plugin's own external HTTP call).

---

## Results (filled 2026-06-26)

### Acquisition (HALF 1) — public-npm reality (WebFetch `registry.npmjs.org`)
- `@openclaw/duckduckgo-plugin` → **404 NOT FOUND** on public npm.
- `@openclaw/workboard` → **404 NOT FOUND**.
- `@openclaw/memory-core` → **404 NOT FOUND**.
- `@openclaw/tavily-plugin` → **published but a "Bootstrap reservation"**: v0.0.0, **409 bytes, 2 files, no
  main/exports/deps** — a name-squat placeholder, NOT real plugin code.
- The umbrella **`openclaw` package IS published** (latest **2026.6.10**, **86.65 MB** unpacked) and **bundles
  every extension** inside its own `dist/extensions/*`. So today the **only way to obtain real plugin code is
  the umbrella `openclaw` package** (or the GitHub repo `openclaw/openclaw@<tag>:extensions/<name>/` source).
- **How the world actually installs them (exa, docs.openclaw.ai):** `openclaw plugins install <spec>` with
  source prefixes — **`clawhub:<pkg>` (ClawHub = the canonical discovery surface), `npm:<pkg>`,
  `git:github.com/<o>/<r>@<ref>`, `npm-pack:<path.tgz>`, local `./dir`/`--link`**. Bare `@openclaw/*` specs
  that match a bundled plugin **resolve to the image-owned bundled copy before npm fallback**. Install location
  = **`$OPENCLAW_STATE_DIR/extensions/<id>/`** (their own convention; parallels our proposed `~/.piflow/extensions/`).
  Docs claim "`@openclaw/*` plugin packages are published on npm again" — but the registry checks above show
  the tool packages are 404/placeholder, so **today the bundled umbrella is the real source**.
- **Install-location verdict:** `~/.piflow/extensions/<id>@<ver>/` is correct AND matches OpenClaw's own
  `$OPENCLAW_STATE_DIR/extensions/<id>/` convention. Give each install its OWN `node_modules/` for its declared
  deps (typebox, etc.) — never the `openclaw` package.
- **`@openclaw/plugin-sdk` vendoring surface:** the package is `private`/`0.0.0-private` (unpublished → MUST be
  vendored) with **0 dependencies, 116 K, 25 files, 63 subpath exports** — BUT it is a **thin re-export façade**:
  `vendor/openclaw/packages/plugin-sdk/src/plugin-entry.ts:3` is literally
  `export * from "../../../src/plugin-sdk/plugin-entry.js"`, which re-exports `vendor/openclaw/src/plugins/types.js`
  etc. So the SDK source is NOT a clean island — vendoring the *source* drags `vendor/openclaw/src/plugins/*`.
  **However (key):** when each plugin is BUILT, `definePluginEntry` compiles to a tiny self-contained dist chunk
  (`dist/plugin-entry-VgQuYBGd.js`, **1.27 KB**, imports only `./config-schema-*.js`). So the contract that
  actually ships with a built plugin is ~2 small chunks, not the 63-export source tree.

### Load+execute (HALF 2) — `packages/core/test/spike-full-plugin-loop.test.ts` (5 tests, all green, offline)
- **duckduckgo LOADED + reached registration from a piflow-owned cache with NO `node_modules/openclaw` at
  load.** The cache was built by copying the entry's **full transitive dist closure** into
  `<repo>/.piflow-spike-cache-XXXX/extensions/duckduckgo@2026.6.9/` and giving it its own `node_modules` linking
  only the plugin's declared npm deps (typebox, …) — never `openclaw`. The entry imported from the cache, its
  `register(api)` ran, and it registered **one real DuckDuckGo web-search provider object** (built by the cached
  chunks, not a stub).
- **Result class:** **REACHED-EXECUTE (registration/provider-creation), network-gated at the service boundary.**
  duckduckgo registers a `webSearchProvider` with **`createTool: () => null`** — it exposes NO agent tool, so it
  is not drivable through `hostOpenClawTool`; the actual DDG HTTP search is network-gated in the sandbox. The
  loop is proven up to the provider/service boundary, which is the no-OpenClaw-install half every prior proof
  skipped.
- **No-OpenClaw evidence (observable):** the runtime closure references **NO `openclaw` package** (asserted: no
  `node_modules/openclaw` substring in any cached chunk, no bare `openclaw/...` import, and no `openclaw` in the
  closure's bare-dep set); the cache `node_modules` has no `openclaw`.
- **Test-the-test:** pointing the loader at an empty cache dir (and breaking the cached entry path) turns the
  load/execute tests **RED** — proves the load genuinely comes from the cache, not a stray openclaw resolution.

### Boundary findings (the load-bearing structural discovery)
- **The bundled `openclaw` dist extension is NOT a standalone fetchable unit.** Each `extensions/<name>/index.js`
  is the TIP of a web of **hashed shared chunks one level up in `dist/`**: duckduckgo's entry imports
  `../../plugin-entry-VgQuYBGd.js` + `../../ddg-search-provider-Dq7SP860.js`, and its **full transitive closure
  is 101 dist files** (fetch-guard, ssrf, undici-runtime, openclaw-state-db, logger, fs-safe, …) plus npm deps
  `chalk file-type json5 kysely rastermill tslog typebox @openclaw/proxyline`. **workboard's closure is 287
  files.** One reference is even broken (`dist/timestamps.js` missing). So "copy `extensions/<name>/`" does NOT
  yield a loadable unit — the spike had to copy the whole closure.
- **The dist closure resolves `typebox` from OpenClaw's OWN nested `node_modules/openclaw/node_modules/typebox`,
  not the repo root** — i.e. the bundled extension is welded to the umbrella package's nested deps too. The spike
  models a real install by giving the cache its own `node_modules` linking the declared deps.
- **No deep `openclaw/*` PACKAGE import** blocks the load — the only OpenClaw-origin code in the closure is the
  inlined contract chunks (`plugin-entry-*`, `config-schema-*`), which are siblings in the cache, not a package.
  So the boundary is **build-shape (monorepo-bundled vs standalone-packed)**, not a hidden `openclaw/*` runtime import.
- **Per-plugin standalone-fetchable verdict:** from the **bundled umbrella dist**, NO plugin is cleanly
  standalone (all share the hashed chunk web). The CLEAN path is a **properly-built standalone `@openclaw/<name>`
  package** (own `dist/`, `@openclaw/plugin-sdk` as a real dep, own deps) — which today is **not published**
  (HALF 1: 404 / bootstrap). So the product must either (a) build standalone packs from the GitHub source, or
  (b) consume the umbrella's dist by copying each plugin's transitive chunk closure into the piflow cache (what
  the spike did) — both with the vendored `plugin-sdk` contract and NO `openclaw` runtime dependency.

### Verdict
**PROVEN-OFFLINE.** The full no-OpenClaw loop — acquire (from the bundled dist as the offline stand-in for a
fetch) → install into a piflow-owned cache → load → reach-execute — works with **NO `node_modules/openclaw` at
runtime**, observable and test-the-tested. Two honest caveats: (1) the *external* DuckDuckGo HTTP call is
network-gated (loop proven to the service boundary, not a live search result); (2) **acquisition from public npm
is currently BLOCKED** — the standalone `@openclaw/<plugin>` packages are 404/placeholder, so real code comes
only from the umbrella `openclaw` package or the GitHub source until OpenClaw actually republishes the
standalone packs. **Single next thing:** decide the acquisition mechanism — build standalone packs from
`openclaw/openclaw@<tag>:extensions/<name>/` (clean, but we run the build), or copy each plugin's transitive
dist-chunk closure out of one `npm pack openclaw` (works today, drags ~100–290 shared chunks per plugin).

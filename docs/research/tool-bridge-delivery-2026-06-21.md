# Tool-bridge delivery into headless `pi` — cross-provider robustness brief

Date: 2026-06-21
Scope: how to make the GENERATED `-e` extension's `@piflow/tool-bridge` (+ its transitive
`@modelcontextprotocol/sdk`) load and execute inside a headless `pi` across ALL sandbox providers
(local temp-dir, seatbelt, worktree, cloud VM) — local↔cloud UNCHANGED.

Primary sources are the on-disk pi loader and the repo files; web sources are secondary and cited by URL.
Anything not confirmable from source is marked **UNVERIFIED**.

---

## 1. Findings

### Coverage 1 — How `-e` loads a file (transpiler, injected/external specifiers, extensions, multi `-e`)

**Transpiler: jiti, NOT esbuild/swc/tsx.** The loader is
`@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`. `loadExtensionModule()` builds a jiti
instance and `jiti.import(extensionPath, { default: true })`:

- loader.js:13 `import { createJiti } from "jiti/static";`
- loader.js:265-272 `const jiti = createJiti(import.meta.url, { moduleCache:false, ...(isBunBinary ? {virtualModules, tryNative:false} : {alias: getAliases()}) }); const module = await jiti.import(extensionPath, {default:true});`
- jiti version is **2.7.0** (`…/pi-coding-agent/node_modules/jiti/package.json:3`). jiti transpiles TS/ESM
  on the fly via Babel (jiti README "Filesystem transpile with hard disk caches"); it does **not** bundle.

**The installed pi runs under Node, so the `alias` branch is taken, NOT `virtualModules`.** The pi
binary is `…/bin/pi -> …/@earendil-works/pi-coding-agent/dist/cli.js`, whose shebang is
`#!/usr/bin/env node` (cli.js:1). `isBunBinary` is true only when `import.meta.url` contains
`$bunfs`/`~BUN` (config.js:16) — false here. **Consequence: extension imports are resolved by jiti's
alias map + ordinary Node resolution, NOT by the bundled `VIRTUAL_MODULES` table.** This is the single
most important fact in this brief and it REFINES the node-contract.ts:47-49 witness (see Coverage 2).

**Specifiers injected / made resolvable (Node/alias mode — the real one here), loader.js:53-92:**
the alias map maps ONLY these IDs to pi's own on-disk entry points:
`typebox`, `typebox/compile`, `typebox/value`, `@sinclair/typebox(+/compile,/value)`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `@earendil-works/pi-ai/oauth`, and the legacy `@mariozechner/*` aliases.
There is NO `pi`/`pi-ai` bare-name beyond those; node builtins (`node:fs`, `node:path`, …) are handled
by Node natively (jiti passes them through). `@piflow/tool-bridge` and `@modelcontextprotocol/sdk` are
**NOT** in the alias map → they fall to ordinary up-tree `node_modules` resolution from the file.

(The Bun-binary `VIRTUAL_MODULES` table, loader.js:29-46, mirrors the same set; it is irrelevant to the
Node install but would matter if pi were later shipped as a Bun single-file binary — see Risks.)

**Accepted file extensions:** `-e` accepts `.ts` and `.js` (`isExtensionFile`, loader.js:361-363:
`name.endsWith(".ts") || name.endsWith(".js")`). jiti also transpiles other TS/ESM forms, but pi's
own discovery filter is `.ts`/`.js`. The runner stages `_pi/tools.ts` (runner.ts:307) — accepted.
**`.mjs` is UNVERIFIED for explicit `-e`** (the discovery filter would reject it; an explicit `-e` path
goes through `resolvePath`+`jiti.import` which jiti can handle, but pi does not advertise `.mjs` — keep
to `.ts`/`.js`).

**Multiple `-e` flags:** pi's loader supports a LIST of extension paths (`loadExtensions(paths, …)`,
loader.js:326-347, iterates `for (const extPath of paths)`). Whether the CLI arg parser accepts repeated
`-e` is **UNVERIFIED from the loader alone** (the arg layer is in main.js/config). The runner currently
passes exactly one `-e` (command.ts:62), so this is not on the critical path. node-contract.ts already
proves the harness loads its own contract extension via a SEPARATE mechanism (PI_RUNNER_CONTRACT_EXT),
implying ≥2 extensions can coexist; treat "multiple `-e`" as plausible-but-unconfirmed.

### Coverage 2 — Module resolution: from WHERE are bare third-party imports resolved

**Resolution base = the EXTENSION FILE's own directory, walking up `node_modules` (standard Node
resolution), NOT pi's node_modules and NOT (reliably) the cwd.** Evidence:

- jiti creates its require relative to the file being loaded: `nativeRequire = parentContext.createRequire(filename)` where `filename` is the resolved extension path (jiti `src/jiti.ts`, https://github.com/unjs/jiti/blob/main/src/jiti.ts). `createRequire(file)` resolves bare specifiers by walking up `node_modules` from that file's directory — Node's documented algorithm.
- The loader resolves the extension path BEFORE import: `resolvedPath = resolvePath(extensionPath, cwd)` (loader.js:297) which canonicalizes/realpaths it (utils/paths.js `resolvePath`/`canonicalizePath`). So the resolution anchor is the *real* on-disk location of `_pi/tools.ts` inside the sandbox.
- A non-aliased workspace package will NOT be magically found: jiti issue #416 (https://github.com/unjs/jiti/issues/416) is the direct witness — jiti "fails to resolve internal monorepo packages" unless they are reachable as real `node_modules` entries or explicitly aliased. `@piflow/tool-bridge` is neither (it is a workspace symlink only inside the repo, see below), so it resolves ONLY if a `node_modules/@piflow/tool-bridge` is reachable up-tree from the staged file.

Repo layout confirming this: `node_modules/@piflow/tool-bridge -> ../../packages/tool-bridge` (workspace
symlink) and `@modelcontextprotocol/sdk` is **hoisted** to the repo-root `node_modules`
(`…/node_modules/@modelcontextprotocol/sdk`). `tool-bridge` is built ESM (`dist/index.js`,
`"type":"module"`, exports `./dist/index.js`) and imports the SDK by subpath
(`dist/clients.js:9-11`: `@modelcontextprotocol/sdk/client/index.js|stdio.js|streamableHttp.js`).

**Per-provider resolve-as-is verdict for the staged `_pi/tools.ts`:**

| Case | Extension file lives at | `@piflow/tool-bridge` resolves as-is? |
|---|---|---|
| (a) file INSIDE repo tree (Seatbelt cwd=repo; Worktree checkout-in-repo) | `<repo>/…/_pi/tools.ts` | **Yes, IF** the repo-root `node_modules` (with the `@piflow/tool-bridge` symlink + hoisted SDK) is up-tree AND readable. Seatbelt: the read-scope must include repo `node_modules`. Worktree: a git checkout does NOT contain `node_modules` unless the worktree shares/links the root's — **conditional**. |
| (b) file in a temp dir OUTSIDE the repo (InMemory provider — `outputDir` is a temp dir outside repo) | `/tmp/…/_pi/tools.ts` | **No.** Walking up from `/tmp/...` never reaches the repo `node_modules`. Resolution fails unless we plant a `node_modules` next to it or bundle. |
| (c) file on an empty cloud VM (Daytona/E2B) | `/workspace/_pi/tools.ts` on a fresh FS | **No.** No `node_modules` exists at all. Resolution fails unless we ship the runtime in. |

So the current `@piflow/tool-bridge` import resolves at MOST in case (a)-with-conditions and NEVER in
(b)/(c). A delivery strategy that depends on up-tree `node_modules` is therefore provider-specific by
construction — it cannot be the cross-provider answer.

### Coverage 3 — Ranked delivery strategies + recommendation

Requirement: ONE artifact that works UNCHANGED across (a)/(b)/(c). The extension is staged as a single
in-sandbox file (`_pi/tools.ts`, runner.ts:303-309) and pi resolves its imports from THAT file's
location. The robust move is to make the file SELF-CONTAINED so resolution never has to leave it —
except for the specifiers pi itself provides (typebox + pi-*), which must stay EXTERNAL.

1. **(i) Pre-BUNDLE the generated extension + `@piflow/tool-bridge` + `@modelcontextprotocol/sdk` into ONE self-contained ESM file via esbuild, externals = `typebox` + `@earendil-works/pi-coding-agent` (and the `@sinclair/typebox`/`@mariozechner/*` aliases + node builtins), then `-e` that one file. — RECOMMENDED.**
   - Cross-provider: identical bytes resolve everywhere because the only remaining imports are the ones pi's loader injects (alias map) and node builtins. No `node_modules` needed in the sandbox. Works in (a), (b), (c) UNCHANGED.
   - Cost: adds esbuild as a build/runtime dependency of `@piflow/core` (it is NOT currently installed). Bundling happens once per extension source on the host, before staging — sandbox stays clean.

2. **(ii) Set `NODE_PATH` to a host `node_modules`.** Fails the cross-provider bar: `NODE_PATH` points at a HOST path that does not exist on a cloud VM or an outside-repo temp dir; also jiti/ESM resolution does not honor `NODE_PATH` the way legacy CJS did (**UNVERIFIED that jiti respects `NODE_PATH` at all**). Provider-specific at best. Reject.

3. **(iii) `npm install` inside the sandbox.** Works in principle on (c) and (b) but: needs network + a registry + a private package publish for `@piflow/tool-bridge` (it is `"private": true`), adds tens of seconds per node, and diverges local vs cloud (Seatbelt/InMemory would also need it). High latency, high fragility, supply-chain surface. Reject as the default.

4. **(iv) Pre-baked VM image with the runtime installed.** Solves (c) elegantly but does NOTHING for (b) local temp-dir or Seatbelt/Worktree, and couples the SDK to a specific image — the opposite of "unchanged local↔cloud." Reject as the cross-provider answer (viable as a cloud-only optimization layered on top of bundling).

**Recommendation: (i) bundle.** It is the only strategy whose ARTIFACT is identical and self-sufficient
across all four providers, needs no sandbox network or `node_modules`, and keeps exactly the pi-provided
specifiers external so pi's loader still injects its own typebox/pi-* (avoiding dual-instance hazards).

### Coverage 4 — If bundling wins: exact esbuild call, ESM acceptance, MCP-SDK gotchas

**esbuild config (host-side, run once on the generated source before staging):**
```
esbuild.build({
  stdin: { contents: <generated extension source>, resolveDir: <packages/tool-bridge or repo root>, loader: 'ts', sourcefile: '_pi/tools.ts' },
  bundle: true,
  format: 'esm',                 // MUST be esm (see TLA / dynamic-require gotchas below)
  platform: 'node',              // node builtins resolve & stay external automatically
  target: ['node20'],            // repo engines.node >=20 (root package.json)
  external: [
    'typebox', 'typebox/compile', 'typebox/value',
    '@sinclair/typebox', '@sinclair/typebox/compile', '@sinclair/typebox/value',
    '@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', '@earendil-works/pi-agent-core',
    '@earendil-works/pi-tui', '@earendil-works/pi-ai/oauth',
    '@mariozechner/pi-coding-agent', '@mariozechner/pi-ai', '@mariozechner/pi-agent-core', '@mariozechner/pi-tui',
  ],
  write: false,                  // capture the string, stage it as _pi/tools.ts
})
```
Rationale for the external list: those are EXACTLY the specifiers pi's loader injects via its alias map
(loader.js:74-90). Leaving them external means the bundled file still says `import { Type } from "typebox"`
and `import { ... } from "@earendil-works/pi-coding-agent"`, which jiti's alias map resolves to pi's OWN
copies — so there is one typebox instance and the injected `pi` object/`defineTool` are the real ones.
Bundling typebox IN would create a second typebox instance and risk `IsUnsafe`/identity mismatches.

**Does pi accept an already-bundled ESM `-e` file?** Yes. jiti transpiles/loads ESM with a default
export; the bundle keeps the `export default function (pi) {…}` factory, which is exactly what
`loadExtensionModule` expects (`jiti.import(path,{default:true})`, loader.js:272; factory must be a
function, loader.js:300-301). esbuild's `format:'esm'` preserves the default export. (`platform:'node'`
keeps `node:*`/builtins as external imports, which jiti/Node resolve natively.)

**MCP-SDK-specific gotchas (version in repo: 1.29.0, ESM+CJS dual build):**
- **Use `format:'esm'`, never `cjs`.** `client/stdio.js` does `import spawn from 'cross-spawn'`
  (`…/sdk/dist/esm/client/stdio.js:1`), and cross-spawn does `require('child_process')`. With a CJS
  output, esbuild emits "Dynamic require of … is not supported" at runtime, and any transitive top-level
  await fails with "Top-level await is currently not supported with the 'cjs' output format"
  (https://github.com/modelcontextprotocol/typescript-sdk/issues/213 ;
  https://dev.to/marcogrcr/nodejs-and-esbuild-beware-of-mixing-cjs-and-esm-493n). ESM output avoids both.
- **stdio transport spawns a child** (cross-spawn → `node:child_process`). With `platform:'node'` this is
  fine: `node:child_process` stays external and resolves on the VM. The child it spawns is the MCP
  SERVER command from bridge config — that server binary must exist in the sandbox (a bridge-config /
  provider concern, NOT a bundling concern). For cloud VMs that cannot spawn local MCP servers, prefer
  `StreamableHTTPClientTransport` (remote) — already imported by the bridge (clients.js:11).
- **`streamableHttp.js` imports `eventsource-parser/stream`** (`…/esm/client/streamableHttp.js:4`) — a
  pure-JS dep, bundles cleanly into ESM.
- **Top-level await:** the client paths the bridge actually uses (`client/index.js`, `client/stdio.js`,
  `client/streamableHttp.js`) have no module-level TLA; the only `await import()` is inside a function in
  `client/auth-extensions.js` (`await import('jose')`), which the bridge does not import. ESM output
  handles dynamic `import()` regardless. So TLA is not expected to bite — but see Risks.
- **CJS interop:** cross-spawn and a few transitive deps are CJS; esbuild ESM output imports CJS npm
  packages fine (the dev.to table: `esm` + `require()` of user/npm modules = supported). Keep node
  builtins external (automatic with `platform:'node'`).

### Coverage 5 — TypeBox `Type.Unsafe(<jsonSchema>)` acceptance

**`Type.Unsafe(raw)` is accepted by pi and advertises the correct shape to the model — confirmed from
source, and it is pi-ai's OWN blessed pattern.**

- TypeBox `Unsafe(schema)` returns the SAME schema object with a `~unsafe` marker:
  `Memory.Update(schema, {['~unsafe']: null}, {})`
  (`…/pi-coding-agent/node_modules/typebox/build/type/types/unsafe.mjs`). So `type`/`properties`/
  `required` remain plain enumerable own properties of the returned object.
- pi-ai's official `StringEnum` helper IS literally `Type.Unsafe({ type:"string", enum:[...] })`
  (`…/pi-ai/dist/utils/typebox-helpers.js:13-19`) — i.e. wrapping a raw JSON Schema in `Type.Unsafe` is
  the documented, in-tree way to hand pi a schema. This validates compile.ts:84 verbatim.
- The providers read the schema straight off `tool.parameters`:
  - OpenAI: `parameters: tool.parameters, // TypeBox already generates JSON Schema`
    (`…/pi-ai/dist/providers/openai-completions.js:819`) — whole object passed through.
  - Anthropic: `const schema = tool.parameters; … input_schema:{ type:"object", properties: schema.properties ?? {}, required: schema.required ?? [] }`
    (`…/pi-ai/dist/providers/anthropic.js:924-933`) — reads `properties`/`required` directly.

**Caveat (does not require a change, but constrains the generated schema):** the Anthropic adapter
HARD-CODES `type:"object"` and reads ONLY `properties`/`required`. compile.ts already emits an
object-typed schema (EMPTY_SCHEMA = `{type:'object',properties:{}}`, compile.ts:69) and the upstream
JSON Schemas from MCP `tools/list` are object-typed, so this is satisfied. A non-object top-level schema
would be silently coerced to an empty object by the Anthropic path — keep generated `parameters`
object-typed (they already are). **No fix needed.** If strict TypeBox were ever required instead, the
isolation point is exactly one line — compile.ts:84 `parameters: Type.Unsafe(${JSON.stringify(params)})`.

---

## 2. Recommendation

**Bundle the generated extension into one self-contained ESM file with esbuild, keeping the
pi-provided specifiers (typebox + `@earendil-works/*` aliases + node builtins) EXTERNAL, then `-e` that
single file.** It is the only option whose staged artifact is byte-identical and self-sufficient across
local temp-dir (InMemory), Seatbelt, Worktree, and cloud (Daytona/E2B): pi's jiti loader resolves the
extension's imports from the file's own location, and after bundling the only imports left are the ones
pi injects via its alias map. No sandbox `node_modules`, no network install, no per-provider image. This
directly fixes the cases the current raw `@piflow/tool-bridge` import CANNOT satisfy (outside-repo temp
dir and empty cloud VM) without changing anything provider-side. Cost: esbuild becomes a new
build-time dependency of `@piflow/core`.

---

## 3. Exact mechanics & where it plugs in

The bundling is a HOST-side transform inserted between "render the extension source" and "stage it",
touching the two cited seams:

- **`packages/core/src/tools/compile.ts`** owns the source string (`renderExtension`/
  `compileToolExtension`, compile.ts:93-113). Add a new step that takes the rendered `source` and returns
  a bundled ESM string via esbuild with the config in Coverage 4 (externals = pi-injected specifiers).
  Keep `renderExtension` pure (plan→render) so the bind-verifier still works; bundling is a SEPARATE,
  composable pass over its output.
- **`packages/core/src/tools/registry.ts`** is where `compileToolExtension(nonBuiltin).source` becomes
  `ResolveResult.extension` (registry.ts:59-60). This is the natural call site to swap in the BUNDLED
  source (host-side, before any sandbox exists) so the rest of the pipeline is unchanged.
- **`packages/core/src/runner/runner.ts:303-309`** stages `resolved.extension` to `_pi/tools.ts` and
  passes it on — UNCHANGED. It will now write the bundled file instead of the thin import-bearing one.
- **`packages/core/src/runner/command.ts:62`** already emits `-e _pi/tools.ts` — UNCHANGED.

esbuild's `resolveDir` for the bundle MUST point at a directory from which `@piflow/tool-bridge` and
`@modelcontextprotocol/sdk` resolve ON THE HOST (the repo root or `packages/tool-bridge`), since
bundling happens host-side where those `node_modules` exist. The bridge's runtime CONFIG (which MCP
servers, stdio vs HTTP, env) still travels separately (the bridge reads `CONFIG_ENV`/`configureBridge`,
tool-bridge index.js) — bundling delivers the CODE, not the config.

---

## 4. Risks & UNVERIFIED (flag for the live pi smoke-test)

- **UNVERIFIED — live load of a bundled ESM `-e` file by jiti 2.7 under Node.** The chain
  (jiti.import → default factory) is confirmed from source, but a real `pi -p … -e <bundled>.ts` run is
  the only way to confirm no surprise (e.g. jiti choking on a large single-file bundle, or
  `interopDefault` proxy interfering with the `pi` arg). HIGH-PRIORITY smoke test.
- **UNVERIFIED — MCP SDK transitive top-level await after bundling.** The bridge's three entry subpaths
  show no module-level TLA, but the full transitive closure of `@modelcontextprotocol/sdk@1.29.0` was not
  exhaustively walked. If esbuild reports "Top-level await is currently not supported" it would only be
  under a `cjs` mistake; with `format:'esm'` TLA is allowed. Verify the bundle builds clean.
- **Risk — externalizing typebox vs bundling it.** Externalizing is correct (one instance via pi's
  alias), but if a future generated extension imported a typebox SUBPATH not in pi's alias map, it would
  fail. The current generator only uses `import { Type } from "typebox"` (compile.ts:99) — safe. Keep the
  generator restricted to aliased specifiers.
- **Risk — stdio MCP servers on cloud VMs.** Bundling delivers the SDK, but `StdioClientTransport`
  spawns a LOCAL server process (cross-spawn → child_process); a cloud VM without that server binary will
  fail at call time, not load time. Prefer HTTP transport for cloud, or provision the server in the
  image. This is a bridge-config/provider concern, orthogonal to delivery.
- **Future risk — Bun single-file pi.** If pi is later shipped as a Bun binary, the loader switches to
  `virtualModules` + `tryNative:false` (loader.js:270). The external list (typebox + pi-*) still matches
  the `VIRTUAL_MODULES` table (loader.js:29-46), so the bundle keeps working — but re-verify, since
  `tryNative:false` makes jiti handle ALL imports.
- **Risk — esbuild as a new dependency.** Adds a binary dep to `@piflow/core`. It is host-side only
  (never staged into a sandbox), so it does not inflate the sandbox; but it must be installed wherever the
  runner runs. Acceptable given it is the only cross-provider-robust option.
- **UNVERIFIED — repeated `-e` flag acceptance at the CLI arg layer** (loader supports a list; arg parser
  not read). Not on the critical path (runner passes one `-e`).

---

## 5. Change-pointer list (prose only — NO code edits made)

- **`packages/core/src/tools/compile.ts`** — add a host-side bundling pass (new function, e.g.
  `bundleExtension(source)`) that runs esbuild with `bundle:true, format:'esm', platform:'node',
  target:['node20']` and the external list = pi-injected specifiers (typebox family +
  `@earendil-works/*` + `@mariozechner/*` aliases). Leave `renderExtension`/`compileToolExtension` pure;
  bundling composes over the rendered string. This is also the one-line isolation point for the TypeBox
  decision (line 84) if strict TypeBox is ever needed.
- **`packages/core/src/tools/registry.ts`** — at the `result.extension = compileToolExtension(...).source`
  site (~line 60), emit the BUNDLED source instead of the raw import-bearing source. Bundle host-side,
  with `resolveDir` anchored where `@piflow/tool-bridge` + `@modelcontextprotocol/sdk` resolve on the
  host. (If bundling is made async, thread the async through `resolve`/the runner's resolve call.)
- **`packages/core/package.json`** — add `esbuild` to dependencies (new build/runtime dep). Confirm
  `engines.node >=20` (already set at the repo root) matches the esbuild `target`.
- **`packages/core/src/runner/runner.ts:303-309`** and **`runner/command.ts:62`** — NO change; they stage
  and reference `_pi/tools.ts` exactly as today (now carrying the bundled file).
- **No change to `@piflow/tool-bridge` or `@modelcontextprotocol/sdk`** — they are inputs to the bundle.

# Tool-bridge ENV + secret delivery — the spawned-pi MCP config gap (2026-06-21)

How the runner should deliver the MCP server config **and its secrets** into a freshly-spawned `pi`
node across all five providers, mirroring the `models.json` secret philosophy
(reference/provider-and-headless.md:21-55), without ever writing a literal secret to disk or blasting
the host env into a cloud VM. This is the ENV half of gap A (config resolution + auth) for
`@piflow/tool-bridge`'s `callTool`.

Scope: research + design only. No source edited. Repo files + the Daytona brief are primary; SDK
behavior is grounded against Context7/Exa and flagged UNVERIFIED where docs don't confirm.

---

## 1. Findings (each coverage item, with citations)

### 1.1 SECRET LOCATION — `$VAR` references in the config; real secrets ride as env vars

**The bridge today uses config values VERBATIM — no expansion.** `makeTransport`
(packages/tool-bridge/src/clients.ts:31-49) passes the config fields straight into the SDK
transports: stdio gets `{ command: cfg.command, args: cfg.args, env: cfg.env, cwd: cfg.cwd }`
(clients.ts:34) and http gets `requestInit: { headers: cfg.headers }` (clients.ts:36-37). `config.ts`
only `JSON.parse`s the file and shape-checks `{ servers }` (config.ts:47-57) — there is **zero**
`$VAR` / `${VAR}` substitution anywhere. So a config value of `"$OPENAI_KEY"` is delivered to the MCP
server as the literal seven-character string `$OPENAI_KEY`, not the secret. The server-config type
(packages/tool-bridge/src/types.ts:36-46) puts secrets exactly where you'd expect: stdio `env?`
(types.ts:38), http `headers?` (types.ts:40).

**Recommendation:** the runner writes `_pi/mcp.json` containing only `$VAR` **references** in those
secret-bearing fields (stdio `env`, http `headers`, and any `$VAR` in `url`/`args`); the real values
travel as **environment variables in the spawned pi child**. `@piflow/tool-bridge` then **must add
`$VAR` / `${VAR}` expansion** to config resolution — expanding against `process.env` of the pi child
(which the runner populated) right after `JSON.parse`, before `makeTransport` ever sees the values.
This mirrors models.json exactly: `apiKey` there "accepts a literal, an env ref `$MY_KEY`, or a
command `!op read ...`" (reference/provider-and-headless.md:50) — the config carries a *reference*, the
secret lives elsewhere.

**Precedent worth naming.** The `${VAR}`-in-config pattern is the *universal* MCP convention, not a
PiFlow invention:
- Claude `.mcp.json` / `claude_desktop_config.json` use `${VAR}` in the `env` block; the explicit
  guidance is "Reference `${VAR}` instead so the secret stays in each developer's environment … keep
  the actual value in a gitignored `.env` file or a secrets manager" (env.dev,
  https://env.dev/guides/mcp-server-env-variables, 2026-06-15).
- VS Code MCP config: `"env": { "API_KEY": "${input:api-key}" }` and `${VAR}` expansion
  (https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).
- 1Password / Token Security pattern: `"env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }`
  with the value resolved from a gitignored ref file at runtime — "Stores all secrets at runtime as
  env variables in the process' memory, which are not written anywhere on disk"
  (https://www.token.security/blog/how-to-stop-exposing-secrets-on-your-mcp-configs, 2026-05-19).
- **`dotenv-expand`** is the canonical npm expander for `${VAR}` / `$VAR` syntax (npm `dotenv-expand`,
  motdotla; supports `${BASIC}` and `$BASIC`). Adopting its *syntax* (and optionally the library) gives
  us a battle-tested, well-understood reference grammar. Note its `expand()` takes a `parsed` object and
  writes to `processEnv`; for our use we want a tiny string-substitution pass over the parsed-JSON
  *values* (expand `$VAR`/`${VAR}` from the child's `process.env`), which we can do directly or by
  feeding values through dotenv-expand. A from-scratch `replace(/\$\{?(\w+)\}?/g, …)` against
  `process.env` is ~5 lines and avoids a dependency; matching dotenv-expand's grammar keeps it familiar.

Optionally also honor a `!cmd` form (run a command, use stdout) to mirror models.json's `!op read …` —
but that is a NICE-TO-HAVE; the `$VAR` reference is the load-bearing piece and is enough.

### 1.2 ENV FORWARDING POLICY — local MAY passthrough; cloud MUST allowlist

Two candidate policies:

- **Full `process.env` passthrough** — the proven LOCAL pattern. run.mjs:58-68 loads pi-runner/.env
  into `process.env` (only if unset) and then forwards the WHOLE `process.env` to the pi child. The
  local providers already do this in `exec`: InMemory merges `{ ...process.env, ...this.env,
  ...opts.env }` (sandbox/index.ts:52), Seatbelt the same (seatbelt.ts:237), Worktree the same
  (worktree.ts:123). On one trusted machine this is fine — the child already runs as you, with your
  full ambient authority, on your own disk.

- **Declared allowlist** — the server configs name exactly which env vars they need (the `$VAR`
  references in `_pi/mcp.json` ARE that declaration), and the runner forwards ONLY those. Tighter blast
  radius: a leaked transcript or a compromised node sees only the secrets it was granted, not your AWS
  keys, GitHub token, and shell history.

**Security trade-off & recommendation.** For LOCAL providers (inmemory/seatbelt/worktree) full
passthrough is the status-quo invariant and acceptable — the child already shares the host's trust
boundary; tightening to an allowlist is defense-in-depth, not a correctness fix. For CLOUD providers
(daytona/e2b) full passthrough is **unacceptable**: it ships your entire host environment —
`DAYTONA_API_KEY`, `OPENAI_API_KEY`, `AWS_*`, `GITHUB_TOKEN`, `CODING_PLAN_API_KEY`, every unrelated
secret — into a remote, billed, possibly-shared VM where it lands as plaintext env on a box you don't
fully control and can't easily scrub. Crucially the cloud providers DON'T do passthrough today:
DaytonaSandbox.exec merges only `{ ...this.env, ...opts.env }` (daytona.ts:260) — **no `process.env`** —
so the host env is already NOT crossing into the VM, and we must keep it that way.

> **CONCRETE RECOMMENDATION:** local providers MAY keep full `process.env` passthrough (status quo);
> cloud providers MUST use a **declared allowlist** — forward only the env vars the node's `_pi/mcp.json`
> `$VAR` references name (plus the small fixed runtime set pi needs). The runner computes the union of
> referenced var names from the node's resolved server map and injects exactly those.

This also dovetails with the MCP-stdio gotcha (1.5): stdio servers do not inherit the shell anyway —
"stdio servers do not inherit your shell environment, so the key must be provided explicitly"
(env.dev) — so the allowlist is the natural model end-to-end.

### 1.3 PER-PROVIDER injection mechanics

The runner's seam is uniform: it builds `CreateOpts.env` from `node.sandbox.env`
(runner.ts:282 → create at 277-284) and stages files with `sandbox.writeFile(rel, data)`
(runner.ts:294, 301, 308). What DIFFERS is where that env actually lands and how the file is delivered.

| Provider | env-injection seam | how `_pi/mcp.json` is delivered | secret handling |
|---|---|---|---|
| **InMemory** | `CreateOpts.env` → stored as `this.env` (index.ts:31); applied per-exec `{...process.env, ...this.env, ...opts.env}` (index.ts:52). | `sandbox.writeFile` → host temp dir (index.ts:42-46). | Local trust boundary; full `process.env` already present. File is on host temp disk — fine locally; still prefer `$VAR` refs for hygiene. |
| **Seatbelt** | Same as InMemory: `CreateOpts.env`→`this.env`; per-exec merge `{...process.env, ...this.env, ...opts.env}` (seatbelt.ts:237). | `sandbox.writeFile` → host temp dir (seatbelt.ts:197-201). | **Read-scope matters:** the kernel denies file-reads outside the granted union. `_pi/mcp.json` lives UNDER the workdir, and `buildSeatbeltProfile` auto-grants the workdir as a recursive `(subpath)` (seatbelt.ts:144-151), so `_pi/` is readable **without extra config**. `node_modules` is likewise auto-granted (workdir + cwd node_modules, seatbelt.ts:145-147) so the bundled bridge resolves; if the generated extension imported a bridge OUTSIDE node_modules its dir would need granting (run.mjs:271 does this for `-e` files). |
| **Worktree** | Same local pattern: `CreateOpts.env`→`this.env`; per-exec `{...process.env, ...this.env, ...opts.env}` (worktree.ts:96, 123). | `sandbox.writeFile` → inside the per-run git worktree (`<wtPath>/<workdir>`, worktree.ts:71). | Local trust boundary. The file is written into the worktree tree — keep `_pi/` gitignored / outside committed paths so refs+config don't get committed (worktree commits on teardown). |
| **Daytona** (cloud) | TWO seams. Create-time: `daytona.create({ envVars })` (daytona.ts:512-518, 534-539) — these are PLAINTEXT on the VM for its whole life. Per-exec: `executeCommand(cmd, cwd, env)` (daytona.ts:277) and the session path bakes env into the command line (daytona.ts:313-316). The exec env is `{ ...this.env, ...opts.env }` (daytona.ts:260) — **no host `process.env`** (good). | `sandbox.writeFile` → `fs.uploadFile(Buffer, remotePath)` UPLOAD API into the VM (daytona.ts:234-241; brief §1 file-system row). | **No first-class secrets store** (UNVERIFIED-as-absent): docs show only `envVars` (plaintext) — confirmed across daytona.io/docs create params (envVars Record<string,string>) and mount/secret guides. Recommended mitigations from the ecosystem: short-lived **scoped tokens** instead of raw keys (Mesa: "Only the token crosses into the sandbox; the API key never does", docs.mesa.dev/.../daytona) or a **sealing proxy** (Oshu Vault: sandbox gets `SEALED_…`, proxy swaps in the real key — "The sandbox never sees your real API key", docs.vault.oshu.dev/.../daytona). For HTTP MCP servers, prefer a remote server URL + per-exec bearer header (allowlisted) over baking a key into `envVars`. |
| **E2B** (cloud) | **Provider NOT implemented in-repo** — `e2b` is in `SandboxProviderKind` (types.ts:44) but has no `*.ts` under packages/core/src/sandbox (only inmemory/seatbelt/worktree/daytona exist); it resolves to `NotImplementedProvider` (index.ts:33, sandbox/index.ts:117-124). DESIGN TARGET from E2B docs: create-time `Sandbox.create({ envs })` (global) and per-command `commands.run(cmd, { envs })` / `runCode(code, { envs })`. | DESIGN TARGET: `sandbox.files.write(path, data)` upload API; bulk `files.write([{path,data},…])`; or a pre-signed `uploadUrl()`. | E2B note: per-command `envs` are "scoped to the command but are NOT private in the OS" (e2b.dev/docs/sandbox/environment-variables) — i.e. visible to other processes in the sandbox, same plaintext-on-VM exposure as Daytona. Same mitigations (scoped tokens / remote HTTP MCP). For a `secure:true` sandbox, pre-signed upload URLs exist. **All E2B rows UNVERIFIED against repo code (no provider yet); grounded only in E2B docs.** |

### 1.4 CONFIG FILE PATH — write `_pi/mcp.json`, set `PIFLOW_MCP_CONFIG` to its ABSOLUTE in-sandbox path

`config.ts:36` reads `process.env[CONFIG_ENV]` (`PIFLOW_MCP_CONFIG`) and `readFileSync(path)`
(config.ts:43) — it does **no path resolution**, so a RELATIVE value resolves against the pi child's
cwd, which differs per provider (InMemory/Seatbelt: a host temp dir; Worktree: the worktree path;
Daytona: `<homeDir>/pi/<run>/<workdir>`, daytona.ts:217-221, 521). A relative `PIFLOW_MCP_CONFIG` is
therefore a cwd-coupling foot-gun.

**Recommendation:** the runner already stages node-owned files under `_pi/` via `sandbox.writeFile`
(runner.ts:300-308 writes `_pi/prompt.md` and `_pi/tools.ts`). Add `_pi/mcp.json` the same way, then
set `PIFLOW_MCP_CONFIG` to its **absolute in-sandbox path** — robust because it ignores cwd entirely.
Each provider already knows that absolute path: local providers resolve `_pi/x` under their workdir
(`this.abs`, index.ts:34-36 / seatbelt.ts:189-191), and Daytona resolves it under the per-node workdir
(daytona.ts:226-228). The runner can compute the absolute path from the provider's `RunScope.root` +
node workdir + `_pi/mcp.json`. (Co-locating with `_pi/tools.ts` also means Seatbelt's existing workdir
grant already covers it — see 1.3.)

### 1.5 STDIO vs HTTP inside a sandbox — HTTP is the sane DEFAULT for cloud; stdio only for local

A `stdio` server config (types.ts:38) makes the bridge **spawn a local `command`**: `makeTransport`
builds `new StdioClientTransport({ command, args, env, cwd })` (clients.ts:34), which `spawn`s that
binary INSIDE the sandbox/VM. That requires the binary to EXIST there. On an **empty cloud VM** it
won't — a `npx @modelcontextprotocol/server-github` needs node+npx+network+the package present in the
Daytona/E2B image, or the connect fails (`connect-failed`, clients.ts:60-64). An `http` server
(types.ts:40) instead opens `StreamableHTTPClientTransport(new URL(url), { requestInit:{ headers }})`
(clients.ts:36-37) — a network call to a server running ELSEWHERE; nothing to install in the sandbox.

Two further stdio facts that shape the design:
- **stdio env is NOT inherited from the shell.** The MCP SDK's `StdioClientTransport.start()` spawns
  with `env: { ...getDefaultEnvironment(), ...serverParams.env }` (modelcontextprotocol/typescript-sdk
  src/client/stdio.ts). `getDefaultEnvironment()` returns ONLY a safe allowlist —
  `['HOME','LOGNAME','PATH','SHELL','TERM','USER']` on POSIX (DEFAULT_INHERITED_ENV_VARS, same file) —
  NOT the full `process.env`. So the secret MUST be in `cfg.env` explicitly (which after 1.1 means a
  `$VAR` ref the bridge expands), and PATH etc. come from `getDefaultEnvironment()` for free. Historical
  gotcha: passing an explicit `env` used to DROP PATH and cause `spawn ENOENT`
  (modelcontextprotocol/typescript-sdk#92, #216); fixed by always merging `getDefaultEnvironment()`,
  which the current SDK does — so our explicit `cfg.env` won't break PATH.
- **HTTP secrets ride in `headers`** (e.g. `Authorization: Bearer …`), passed verbatim today
  (clients.ts:37) → same `$VAR`-expansion requirement as stdio `env`.

> **RECOMMENDATION:** **HTTP/remote is the sane DEFAULT for sandboxed nodes**, and the ONLY sane choice
> for cloud (daytona/e2b) — the MCP server runs outside the empty VM, the node just makes an
> authenticated network call, and the secret is a single allowlisted header var. **stdio is acceptable
> ONLY on local providers** (inmemory/seatbelt/worktree) where the host already has node/npx/the server
> package — and even there it is subject to Seatbelt read-scope (the spawned server binary + its deps
> must be inside the granted union). On cloud, stdio requires baking the server into the image; treat
> that as an explicit opt-in, not the default.

---

## 2. Recommendation — the env + secret design

**Principle (mirrors models.json):** `_pi/mcp.json` is *wiring-only* — it carries `$VAR` references,
never literal secrets. The real secrets exist only as environment variables in the spawned pi child,
injected by the runner via the provider's env seam, and expanded by `@piflow/tool-bridge` at config
resolution. Nothing secret is ever written to disk as a literal; on cloud, only the *allowlisted*
referenced vars cross into the VM.

**Per-provider table:**

| Provider | env-injection seam | file-delivery (`_pi/mcp.json`) | secret handling | stdio allowed? |
|---|---|---|---|---|
| InMemory | `CreateOpts.env`→exec merge `{...process.env,...env}` (index.ts:52) | `writeFile` (host temp) | full passthrough OK (local trust); `$VAR` refs for hygiene | Yes (local has the binary) |
| Seatbelt | `CreateOpts.env`→exec merge (seatbelt.ts:237) | `writeFile` (host temp, under workdir → auto-granted) | full passthrough OK; read-scope already covers `_pi/` + node_modules | Yes, IF server binary+deps inside the granted read union |
| Worktree | `CreateOpts.env`→exec merge (worktree.ts:123) | `writeFile` (inside worktree) | full passthrough OK; keep `_pi/` out of committed paths | Yes (local has the binary) |
| Daytona | per-exec `executeCommand(cmd,cwd,env)` / session env-prefix (daytona.ts:277,313-316); NO host `process.env` | `fs.uploadFile(Buffer,remotePath)` (daytona.ts:240) | **ALLOWLIST only**; no native secret store → prefer scoped tokens / sealing proxy; raw key in `envVars` = plaintext-on-VM | **Discouraged** — empty VM has no binary; HTTP/remote default |
| E2B (unimpl.) | DESIGN: `create({envs})` + `commands.run(cmd,{envs})` | DESIGN: `files.write(path,data)` / `uploadUrl()` | **ALLOWLIST only**; per-cmd envs "not private in the OS"; scoped tokens preferred | **Discouraged** — empty VM; HTTP/remote default |

**Forwarding policy:** local = full `process.env` passthrough (status quo, acceptable). Cloud = declared
allowlist — forward ONLY the `$VAR` names referenced by the node's resolved server map (+ the minimal
fixed set). Default transport for sandboxed nodes = HTTP/remote; stdio is a local-only / image-baked
opt-in.

---

## 3. Exact mechanics — what the runner writes/sets per node

Per node, in the staging block (runner.ts:289-309), AFTER resolving tools and BEFORE building the
command (runner.ts:319). Only when the node selected MCP tools (i.e. `resolved.extension` is present
and references `mcp.<server>:<tool>`):

1. **Build the server map.** From the node's selected MCP tools, assemble `{ servers: { <name>:
   <McpServerConfig> } }` where every secret-bearing field holds a `$VAR` reference, NOT a literal —
   e.g. http `{ transport:'http', url, headers:{ Authorization:'Bearer $GITHUB_TOKEN' } }`, or stdio
   `{ transport:'stdio', command, args, env:{ GITHUB_PERSONAL_ACCESS_TOKEN:'$GITHUB_TOKEN' } }`. (Where
   this map comes from — registry entry, run config — is gap A's *config-source* half, out of scope
   here; this brief covers how it's DELIVERED + SECURED.)

2. **Write the config file.** `await sandbox.writeFile('_pi/mcp.json', JSON.stringify(map))` —
   identical mechanism to the existing `_pi/prompt.md` (runner.ts:301) and `_pi/tools.ts`
   (runner.ts:308). It lands under the node workdir on every provider; on Seatbelt the workdir grant
   already makes it readable.

3. **Set `PIFLOW_MCP_CONFIG` + the secret env.** Add to `node.sandbox.env` (which flows to
   `CreateOpts.env` at runner.ts:282 and then into every `exec`): `PIFLOW_MCP_CONFIG` = the **absolute**
   in-sandbox path of `_pi/mcp.json` (computed from `RunScope.root` + workdir + `_pi/mcp.json`), PLUS
   the actual secret values for each referenced `$VAR` — but on CLOUD providers, ONLY the allowlisted
   referenced vars (compute the set of `$VAR` names from the map; copy those from the host/secret source
   into the child env). On local providers the full `process.env` is already forwarded so only
   `PIFLOW_MCP_CONFIG` + any non-ambient secrets need adding.

4. **The bridge resolves + expands.** Inside the pi child, the generated `_pi/tools.ts`' first
   `callTool` triggers `resolveConfig()` → `loadEnvConfig()` (config.ts:33-58), which reads
   `_pi/mcp.json`. **CHANGE (gap A's env fix):** after `JSON.parse` (config.ts:49) and before returning,
   run a `$VAR`/`${VAR}` expansion pass over the parsed server-config string values (env, headers, url,
   args), substituting from the child's `process.env`. Then `makeTransport` (clients.ts:31) builds the
   transport from already-resolved values, with the real secret never having touched `_pi/mcp.json`.

**`@piflow/tool-bridge` change ($VAR expansion):** add an expansion step in config resolution
(packages/tool-bridge/src/config.ts), expanding `$VAR` / `${VAR}` in `McpServerConfig` string fields
against `process.env`. Adopt dotenv-expand's grammar (optionally the library, optionally also `!cmd`).
A missing referenced var should fail loudly (a `not-configured` / new `missing-env` BridgeError) rather
than silently passing an empty/literal value to a server — a silent miss yields a confusing
`connect-failed` (clients.ts:60-64) downstream.

---

## 4. Risks & UNVERIFIED

- **UNVERIFIED — E2B provider does not exist in-repo.** `e2b` is only a `SandboxProviderKind` union
  member (types.ts:44); there is no E2B sandbox impl (it resolves to `NotImplementedProvider`,
  index.ts:33). All E2B rows are DESIGN TARGETS grounded in E2B docs
  (e2b.dev/docs/sandbox/environment-variables, sdk-reference js-sdk), not against repo code. The env
  seam (`create({envs})` / `commands.run(cmd,{envs})`) and file API (`files.write`) are doc-confirmed
  but the mapping onto the `Sandbox`/`CreateOpts` contract is unbuilt.
- **UNVERIFIED — no native Daytona/E2B "secret store" beyond plaintext env.** Daytona docs expose only
  `envVars` (create) and per-exec `env`; no first-class encrypted secret resource is documented (mount
  guides pass `AWS_*` as plaintext envVars). E2B per-command envs are explicitly "not private in the OS."
  Conclusion: on cloud, a secret in env IS plaintext on the VM — the mitigation is **not** a provider
  feature but a pattern (scoped short-lived tokens / a sealing proxy / remote HTTP MCP with bearer
  header). Treat "secret never on the VM in clear" as achievable ONLY via those patterns, flagged.
- **RISK — cloud env passthrough regression.** If a future composed/cloud provider ever copies the
  local `{...process.env, ...}` merge (index.ts:52) into its exec, it would silently blast the host env
  into the VM. The allowlist must be enforced at the RUNNER (what it puts in `CreateOpts.env`), and the
  cloud provider exec must continue to NOT spread `process.env` (daytona.ts:260 is correct today —
  guard against drift).
- **RISK — `_pi/mcp.json` committed by the worktree provider.** Worktree commits its tree on teardown;
  if `_pi/` is inside committed paths a refs-only config (no literals) still leaks server URLs/structure
  into git. Keep `_pi/` gitignored / excluded from the worktree commit set.
- **RISK — silent `$VAR` miss.** Without a loud failure on an unresolved reference, the literal `$VAR`
  string reaches the server as a bogus credential → opaque `connect-failed`. Fail fast in the bridge.
- **RISK — Seatbelt read-scope for a non-bundled stdio server.** A stdio server binary/deps outside the
  granted union (workdir, workdir/node_modules, cwd/node_modules — seatbelt.ts:144-147) will EPERM on
  read; granting its dir is required (as run.mjs:271 does for `-e` files). HTTP avoids this entirely.

---

## 5. Change-pointer list (files that change — prose, NO edits)

- **packages/tool-bridge/src/config.ts** — add the `$VAR`/`${VAR}` expansion pass in `loadEnvConfig`
  after `JSON.parse` (config.ts:49), expanding the `McpServerConfig` string fields (env/headers/url/args)
  against `process.env`; fail loudly on an unresolved reference. This is the core gap-A env fix.
- **packages/tool-bridge/src/errors.ts** — (optional) a new `missing-env` BridgeError kind for an
  unresolved `$VAR`, so the failure is distinct from `not-configured` / `connect-failed`.
- **packages/tool-bridge/src/clients.ts** — no change to `makeTransport` (it consumes already-expanded
  values); it stays the consumer of the resolved config (clients.ts:31-49).
- **packages/core/src/runner/runner.ts** — in the staging block (around runner.ts:300-309): build the
  server map with `$VAR` refs, `writeFile('_pi/mcp.json', …)`, and add `PIFLOW_MCP_CONFIG` (absolute
  in-sandbox path) + the referenced secret env to `node.sandbox.env` / `CreateOpts.env`
  (runner.ts:277-284); apply the cloud ALLOWLIST when the provider kind is daytona/e2b.
- **packages/core/src/types.ts** — (optional) if the allowlist becomes a first-class concept, document
  it on `CreateOpts.env` / `SandboxSpec.env` (types.ts:65, 209) — e.g. a note that cloud providers
  forward only declared vars. No structural change strictly required.
- **packages/core/src/sandbox/daytona.ts** — no change needed (per-exec env already excludes
  `process.env`, daytona.ts:260); add an inline note that cloud env is the ALLOWLIST seam so a future
  edit doesn't reintroduce host-env spread.
- **packages/core/src/sandbox/e2b.ts** — does NOT exist; would need to be CREATED to implement the E2B
  provider (env via `create({envs})` + per-exec `envs`, files via `files.write`) before any of its rows
  above are real. Out of scope for this brief (flagged in §4).

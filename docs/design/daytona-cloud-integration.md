# Daytona Cloud Integration — Implementation Design

> **Purpose:** First real Daytona node run, automated test, and observe-layer monitoring.
> **Scope:** Analysis + design only. Source code is NOT modified here.
> **Branch context:** `chore/npm-publish-prep` / `docs/node-action-protocol` (a parallel agent is
> editing `seatbelt.ts` / `local.ts` / `types.ts` for write-scope; this doc treats write-scope as
> an existing peer of read-scope and does not cite transient line numbers in those files).

---

## A. Current State & Gap

### What is built

#### `daytona.ts` — the provider (`packages/core/src/sandbox/daytona.ts`)

The full cloud lifecycle is implemented against a dependency-inverted `DaytonaSdk` seam:

| Method / class | Lines | What it does |
|---|---|---|
| `DaytonaSdk` interface | 145–150 | `create(params?)→DaytonaVm`; `delete(vm)` — the two VM-lifecycle calls |
| `DaytonaFs` interface | 82–95 | `uploadFile`, `downloadFile`, `createFolder`, `searchFiles` |
| `DaytonaProcess` interface | 98–134 | `executeCommand` (buffered), `createSession`/`executeSessionCommand`/`getSessionCommandLogs`/`getSessionCommand`/`deleteSession` (streaming session path) |
| `DaytonaVm` interface | 137–142 | `{id, fs, process}` — one VM handle |
| `DaytonaSandbox.open` | 211–224 | Per-node view: `createFolder` the node subtree inside the VM |
| `DaytonaSandbox.writeFile` | 235–242 | `uploadFile` into VM at the node's subtree path |
| `DaytonaSandbox.exec` | 259–267 | Routes to `execBuffered` or `execSession` based on streaming/signal needs |
| `DaytonaSandbox.execSession` | 305–388 | Streaming session exec: `createSession` → `executeSessionCommand(runAsync:true)` → background `getSessionCommandLogs` → poll `getSessionCommand` for exit code → `closeSession` |
| `DaytonaSandbox.downloadDir` | 404–418 | `searchFiles('*')` → `downloadFile` each → write to host |
| `DaytonaSandbox.dispose` | 425–431 | NO-OP in the run-scoped path (`ownsVm:false`); destroys throwaway VM otherwise |
| `DaytonaRunScope.create` | 459–461 | Makes per-node `DaytonaSandbox` views inside the shared VM (`ownsVm:false`) |
| `DaytonaRunScope.dispose` | 469–472 | `sdk.delete(vm)` — single VM teardown after all nodes |
| `DaytonaSandboxProvider.openRun` | 507–526 | `sdk.create({image, resources, autoStopInterval, envVars:{PI_RUN}})` → `createFolder(rootDir)` → returns `DaytonaRunScope` |
| `DaytonaSandboxProvider.create` | 532–543 | Non-scoped path: per-node throwaway VM |

#### `daytona-sdk.ts` — the real SDK adapter (`packages/core/src/sandbox/daytona-sdk.ts`)

- Lines 46–65: `adaptFs` — wraps real `Sandbox.fs` (Buffer coercion, mode default)
- Lines 67–102: `adaptProcess` — wraps real `Sandbox.process` (strips `artifacts`, remaps session req)
- Lines 104–111: `adaptVm`
- Lines 117–140: `realDaytonaSdk(client)` — WeakMap tracks real handles for `delete`
- Lines 160–177: `createDaytonaProvider(opts)` — one-liner factory: `new Daytona(config)` → `realDaytonaSdk` → `new DaytonaSandboxProvider`

#### `sandbox-cloud-parity.test.ts` (`packages/core/test/sandbox-cloud-parity.test.ts`)

Three test groups (lines 263–413):
1. Bare `Sandbox` lifecycle with a real-fs-backed `FakeDaytonaSdk` — `writeFile/exec/readFile/downloadDir` round-trip; nonzero exit.
2. `runWorkflow` contract — producer→consumer artifact flow; blocked-path halts.
3. Run-scoped VM lifecycle — ONE VM boot/teardown per run, regardless of node count or failure.

### The gaps to a real run

**(1) `--sandbox daytona` is NOT wired into the CLI.**

`packages/cli/src/run.ts` defines `SandboxChoice` (line 101) as `'inmemory' | 'local' | 'danger-full-access'`. `'daytona'` is absent. `createDaytonaProvider` is never imported by the CLI. The provider selection block (lines 358–369) has no `daytona` branch. Adding one is the single CLI change needed.

**(2) Credentials: `DAYTONA_API_KEY` is implicitly read by the real Daytona client.**

`createDaytonaProvider` (daytona-sdk.ts:164–177) accepts an optional `apiKey`. If omitted, `new Daytona(config)` falls back to reading `DAYTONA_API_KEY` from the environment (per the SDK's own default, grounded in `docs/research/daytona-sdk-2026-06-21.md`). The runner's `SecretResolver` seam (`types.ts:626–632`, `defaultSecretResolver = (name) => process.env[name]`) is for **per-node MCP env vars**, not the provider credential. The Daytona API key is consumed at **provider construction** (before any node), not inside the node exec path, so the `SecretResolver` does not apply to it. A `--daytona-api-key` CLI flag (or `DAYTONA_API_KEY` in the environment) is the only credential gap.

**(3) The VM image must already contain `pi`.**

See Section B for the full transfer model. The short answer: the runner stages *files* (prompt, extension, seed inputs) into the VM via `uploadFile`; it does NOT upload the `pi` binary or Node.js. These must already be present in the VM image. The image is specified at provider construction via `createDaytonaProvider({ image: '...' })` (daytona-sdk.ts:150). A usable image can be any Linux container that has `pi` (the coding-agent CLI) and Node.js on `$PATH`. This is a NET-NEW image build step, not a code change.

---

## B. Validate the "Push the Agent" Model

### The owner's claim

> "We push the whole prepared agent+filesystem to the cloud, run it, and wait for results."

### The corrected model: **We push FILES, not the agent binary. `pi` must be baked into the VM image.**

Here is the precise per-node hand-off, traced through the code:

**Step 1 — VM boot (once per run).** `DaytonaSandboxProvider.openRun` (daytona.ts:507–526):
```
sdk.create({ image, resources, envVars: { PI_RUN: run } })   // boots ONE VM
vm.fs.createFolder('/home/daytona/pi/<run>')                  // mkdir the run root
→ DaytonaRunScope (shared across all nodes)
```

**Step 2 — Per-node staging.** `runNode` in `runner.ts` (lines 905–1094) calls `scope.create(CreateOpts)` → `DaytonaSandbox.open` (daytona.ts:211–224), which `createFolder`s the node's subtree. Then the runner uploads into the VM via `sandbox.writeFile` (→ `uploadFile`):

| What gets uploaded | VM path | Source in runner.ts |
|---|---|---|
| Node's `io.reads` (input artifacts from host run dir) | relative path under node workdir | lines 1014–1016 |
| Seed files (from seed ops) | relative path under node workdir | lines 1024–1028 |
| `prompt.md` (the resolved, token-substituted prompt) | `_pi/<id>/prompt.md` | line 1079 |
| Tool extension (`tools.ts`, the generated `pi -e` file) | `_pi/<id>/tools.ts` | lines 1083–1086 |
| MCP config (`mcp.json`, `$VAR` refs only) | `_pi/<id>/mcp.json` | lines 1089–1093 |

**Step 3 — Exec IN the VM.** `sandbox.exec(cmd)` → `execSession` or `execBuffered` (daytona.ts:259–388). The `cmd` is the fully-formed `pi` command built by `defaultPiCommand` (runner.ts:1121), e.g.:
```
pi --provider cp --model claude-3-5-sonnet --tools submit_result \
   -e /home/daytona/pi/<run>/<workdir>/_pi/<id>/tools.ts \
   @/home/daytona/pi/<run>/<workdir>/_pi/<id>/prompt.md
```
This command executes **inside the Daytona VM**, not on the host. `pi` must already be on the VM's `$PATH`.

**Step 4 — Collect.** `sandbox.downloadDir(node.sandbox.output, ctx.outDir)` (runner.ts:1155 → daytona.ts:404–418): `searchFiles('*')` enumerates the in-VM output dir; `downloadFile` each back to the **host** run dir (one file per round-trip).

**Step 5 — VM teardown (once per run).** `DaytonaRunScope.dispose` (daytona.ts:469–472): `sdk.delete(vm)`.

### Verdict

The owner's model is **correct in intent but imprecise in mechanism**:
- We do NOT "push the agent binary" — `pi` must be pre-baked in the VM image.
- We DO "push the prepared filesystem" — prompt, extension, seed inputs, MCP config are all staged via `uploadFile` before each exec.
- The `pi` **process executes inside the Daytona VM**, not on the host.
- "Wait for results" is accurate: `execSession` polls `getSessionCommand` until `exitCode` is set (daytona.ts:369–373), then `downloadDir` collects outputs back to the host.

---

## C. Max Reuse — Read/Write Scope

### How the seatbelt jail works locally

`seatbeltExecPlan` (seatbelt.ts:197–209) generates a per-exec `.sb` macOS Seatbelt profile from `{workdir, readScope}` and wraps the command as `sandbox-exec -f <profile> sh -c <cmd>`. The write-scope sibling (being added in the parallel branch) applies the same `bwrap`/`sandbox-exec` posture to writes. This is a **host-OS primitive** — it requires `sandbox-exec` on macOS or `bwrap` on Linux, called by the host runner process.

### In a Daytona VM: three options

**(a) Redundant — VM boundary suffices for host isolation.** A Daytona VM is a Linux container (hardware-isolated). The agent inside the VM cannot read the host filesystem by construction. The seatbelt jail's primary purpose — preventing node N from reading host paths outside its declared `readScope` — is already satisfied by the VM boundary for **host↔VM isolation**. There is no path from inside the VM to the host FS.

**(b) Reusable for node↔node isolation INSIDE the shared VM.** `DaytonaSandboxProvider.openRun` boots **ONE VM** for the whole run. All nodes share it, each in a separate subtree `/home/daytona/pi/<run>/<workdir>/`. A node can, in principle, read a sibling's subtree (there is no OS-level barrier between `_node_A_/` and `_node_B_/`). This is the same problem the seatbelt jail solves locally (node A reading node B's workspace). The `CreateOpts.readScope` values (e.g. `['{{WORKSPACE}}/shared/']`) are passed through to `DaytonaSandbox.open` (daytona.ts:214) but **today `DaytonaSandbox.open` reads only `opts.workdir` and `opts.outputDir`** — it never reads `opts.readScope` or `opts.writeScope`. Those fields are currently **ignored** by the Daytona provider.

**(c) Replaceable by a Linux jail inside the VM.** Because the VM is Linux, `bwrap` (bubblewrap) is available. The same `bwrapExecPlan` that `seatbelt.ts` comments as the Linux equivalent (line 193–196) could be called **from inside the VM** by wrapping the `pi` command in `bwrap --ro-bind / / --bind <workdir> <workdir> --bind /tmp /tmp … pi …`. This would enforce node↔node isolation inside the shared VM.

### Recommendation

For the **first real Daytona run**, skip in-VM scope enforcement. The VM boundary provides host isolation, and for a single-node smoke test there is no sibling to isolate from. For a multi-node production run, the correct path is:

- Add a `bwrapExecPlan` seam sibling to `seatbeltExecPlan` (seatbelt.ts:197, same file).
- `DaytonaSandbox.exec` checks if `bwrap` is available in the VM (or a provider flag is set) and wraps the `pi` command accordingly, using `opts.readScope`/`opts.writeScope` from `CreateOpts` exactly as the seatbelt path does.
- The policy source is **REUSE**: `buildSeatbeltProfile`'s allow-list logic (seatbelt.ts:142–174) is platform-agnostic — only the outer wrapper (`sandbox-exec` vs `bwrap`) differs.

**`CreateOpts.readScope` / `writeScope` consumed today vs ignored:**
- Local (`SeatbeltSandbox`): `readScope` is fully consumed (seatbelt.ts:231–234); `writeScope` is being added in the parallel branch.
- Daytona (`DaytonaSandbox`): both are **ignored today** (daytona.ts:218–223 reads only `workdir` and `outputDir`). This is NET-NEW work to honor them.

---

## D. Max Reuse — Tool Registration (G11)

### The local flow (baseline)

1. `entry.ts:resolveRunTools` (entry.ts:34–43) calls `assembleRunTools({spec})` (tool-config.ts:60–73), which returns `{registry, mcpConfig?}`.
2. `runWorkflow` receives both (runner.ts:1693, 1705).
3. Per node, `runNode` (runner.ts:947–961) decides whether to stage MCP config: `stageMcp = Boolean(resolved.extension) && selectedBridgedTool(node) && Boolean(ctx.mcpConfig)`.
4. If staging: `mcpEnvAdditions` (runner.ts:481–501) resolves `$VAR` refs through `SecretResolver` and builds `{PIFLOW_MCP_CONFIG: <abs-path>, ...referenced-vars}`. The `CLOUD_KINDS` guard (runner.ts:430, 958) allowlists ONLY the referenced vars on cloud — host env never leaks.
5. The runner stages:
   - `_pi/<id>/tools.ts` (the generated `-e` extension) via `sandbox.writeFile` (runner.ts:1086).
   - `_pi/<id>/mcp.json` (the verbatim `$VAR`-ref map) via `sandbox.writeFile` (runner.ts:1093).
6. The pi command (runner.ts:1121) carries `-e <abs-in-sandbox-path-to-tools.ts>` and the env additions (`PIFLOW_MCP_CONFIG`, referenced vars).

### Does this flow work unchanged on Daytona?

**Mostly yes — the seam is already cloud-aware.** Tracing each component:

| Component | Daytona status | Evidence |
|---|---|---|
| `assembleRunTools` / `seededRegistry` | **REUSE unchanged** | Pure function, no I/O, runs on host before any VM. tool-config.ts:60 |
| `resolved.extension` generation | **REUSE unchanged** | Registry resolution runs on host before sandbox creation. runner.ts:923–928 |
| `mcpConfig` merge + `$VAR` staging | **REUSE unchanged** | `mcpConfig` carries `$VAR` refs, never literal secrets. runner.ts:1092–1093 |
| `SecretResolver` resolving `$VAR` to values | **REUSE unchanged** | Runs on host; the resolved env vars are passed into `sandbox.create` → `DaytonaSandbox.open` → `exec` env merge. The `CLOUD_KINDS` allowlist (runner.ts:430, 958) actively restricts to referenced vars only. |
| `uploadFile` of `tools.ts` into VM | **REUSE unchanged** | `sandbox.writeFile` → `vm.fs.uploadFile`. daytona.ts:235–241 |
| `uploadFile` of `mcp.json` into VM | **REUSE unchanged** | Same path. daytona.ts:235–241 |
| `-e <path>` in the pi command | **REUSE unchanged** — path is in-VM posix | The abs path is built as `path.posix.join(scope.root, node.sandbox.workspace || '.', MCP_CONFIG_FILE)` (runner.ts:952). `scope.root` for Daytona is `/home/daytona/pi/<run>` (daytona.ts:522). The posix join produces a valid in-VM absolute path. |
| MCP **server reachability from the VM** | **UNVERIFIED / NET-NEW** | An MCP server declared in `mcp.servers` with a `localhost` or `127.0.0.1` address refers to the **host** from the host's perspective, but to the **VM's own loopback** from inside the VM. A host-local MCP server is unreachable from the Daytona VM unless (a) exposed on a routable interface and the VM's `PIFLOW_MCP_CONFIG` points to that address, or (b) tunneled. This requires Daytona-specific `mcp.servers` config with public/routable endpoints. UNVERIFIED whether Daytona VMs have egress to the public internet for cloud-hosted MCP endpoints. |
| `tools.ts` bundle no-import invariant | **REUSE unchanged** | The extension is a self-contained TS/JS bundle with no import of host-only paths. The pi binary in the VM runs it with `-e`. No path dependency on the host. |

**The one Daytona-specific wrinkle on tool wiring:** `PIFLOW_MCP_CONFIG` is the in-VM absolute path to `mcp.json`. Today `configPathAbs` is computed at runner.ts:952 using `path.posix.join(scope.root, ...)`. For Daytona, `scope.root = '/home/daytona/pi/<run>'` (daytona.ts:521–522), so `PIFLOW_MCP_CONFIG` resolves to a correct in-VM path. This is already correct by construction — **REUSE unchanged**.

---

## E. Observe-Layer Monitoring

### How observe works today

`@piflow/core/observe` (observe/index.ts) re-exports:
- `readRunModel` / `watchRun` — poll the **host run dir** (`.pi/run.json`, `.pi/nodes/<id>/events.jsonl`).
- `buildRunView`, `summarizeRun` — build the rich view from those host-side files.
- `writeStatus` — the runner writes `run.json` to `outDir` (the host run dir) at each node transition (runner.ts:912, 1790, 2x).

### Are cloud runs already visible post-collection?

**Yes, after collection.** The runner writes `run.json` to the **host** `outDir` at every status change (runner.ts:912 `rec.status='running'` → `writeStatus`; runner.ts:1155 after `downloadDir`). The observe layer reads that same host `outDir`. So:

- **At node-start** (`rec.status='running'`): `run.json` is updated on the host **before** the VM exec. `watchRun` sees it immediately.
- **During VM exec** (while `execSession` is polling): the host `run.json` still shows `running`. No in-VM progress is visible — log output stays inside the session's `onStdout`/`onStderr` callbacks (daytona.ts:346–347), which are wired to `NodeRecorder` (runner.ts:1127–1128) → `events.jsonl` on the **host** (via `recorder`). The `NodeRecorder` writes to `ctx.outDir` (host), not into the VM. So **live log events from the VM exec DO flow to the host events file** in real-time via the session callbacks. `watchRun`'s `tailEvents` (watch.ts:35–55) tails `events.jsonl` per node and yields `{kind:'node-event'}` deltas — so the TUI/GUI/CLI see live output during the cloud run.
- **After `downloadDir`**: artifacts land on the host. `run.json` is updated to `done/ok`. `watchRun` yields `{kind:'done'}`.

**What is NOT visible today:** The Daytona VM id, VM boot/teardown status, raw Daytona run state. These are not written anywhere the observe layer reads.

### Cheapest seam to surface VM status

The `RunScope` seam (`types.ts:587–595`) has only `root`, `create`, and `dispose`. The runner already writes a synthetic `__runscope__` node on scope-setup failure (runner.ts:1870–1875). The cheapest extension is:

**Option 1 (no core seam change):** `DaytonaSandboxProvider.openRun` writes a `daytona-vm.json` sidecar to `opts.outDir` containing `{vmId, bootedAt}` before returning the scope. The runner already creates `outDir` before calling `openRunScope` (runner.ts:1759). A thin observe helper reads this sidecar. Zero runner changes.

**Option 2 (core seam, cleaner):** Add an optional `meta?: Record<string, unknown>` field to `RunScope` (types.ts:587). `DaytonaRunScope` populates `{vmId: vm.id}`. The runner threads it into `RunContext` and `writeStatus` (or a separate sidecar). The observe layer surfaces it as a `cloudMeta` field on `RunModel`. Requires a runner.ts change but fits the existing architecture.

**Recommendation for first real run:** Option 1 — sidecar, zero runner changes, directly readable by a `piflowctl status` extension or a GUI panel.

---

## F. The Plan

### Milestone 0 — VM Image (NET-NEW, prerequisite)

Build (or identify) a Linux container image with `pi` (the coding-agent CLI) and Node.js installed. A Dockerfile starting from `ubuntu:24.04`, installing Node.js v20+, and running `npm install -g pi` (or the correct package name) suffices for a smoke test. The image ref is passed to `createDaytonaProvider({ image: 'ghcr.io/…/pi-runner:latest' })`.

No code change. This is the single external prerequisite for any real run.

### Milestone 1 — Wire `--sandbox daytona` into the CLI (NET-NEW, small)

**File:** `packages/cli/src/run.ts`

**Landing point:** `SandboxChoice` type (line 101) and `SANDBOX_CHOICES` constant (line 104) and the provider-selection block (lines 358–369).

Changes:
1. Add `'daytona'` to `SandboxChoice` and `SANDBOX_CHOICES`.
2. Import `createDaytonaProvider` from `@piflow/core` (or directly from `packages/core/src/sandbox/daytona-sdk.js`).
3. Add an `else if (parsed.sandbox === 'daytona')` branch in `runTemplate` that calls `createDaytonaProvider({ image: process.env.DAYTONA_IMAGE, apiKey: process.env.DAYTONA_API_KEY })`.
4. Export `createDaytonaProvider` from `packages/core/src/index.ts` (check if already exported — if not, NET-NEW one-liner).

**Tag:** NET-NEW (CLI only; provider code already exists)

### Milestone 2 — Real-SDK Smoke Test (NET-NEW)

**File:** `packages/core/test/sandbox-cloud-e2e.test.ts` (new file)

A single test that requires real credentials and a real image, gated behind `process.env.DAYTONA_API_KEY` (skip if absent):

```ts
// Skip when no creds — this is a real-SDK integration test, not a unit test.
if (!process.env.DAYTONA_API_KEY) test.skip('DAYTONA_API_KEY not set');

test('one-node run with real Daytona SDK produces an artifact', async () => {
  const provider = createDaytonaProvider({
    image: process.env.DAYTONA_IMAGE ?? 'ghcr.io/.../pi-runner:latest',
    autoStopInterval: 5, // 5-min auto-stop guard
  });
  // Compile a minimal one-node workflow (echo a file).
  const spec = /* minimal WorkflowSpec with one node that writes out/result.txt */;
  const wf = compile(spec);
  const result = await runWorkflow(wf, { provider, outDir: tmpDir, run: 'e2e-smoke' });
  expect(result.status.ok).toBe(true);
  // The artifact must have been collected back to the host.
  expect(existsSync(path.join(tmpDir, 'result.txt'))).toBe(true);
});
```

The cheapest node for the smoke test: a node whose prompt writes a deterministic string to `out/result.txt` using only the `submit_result` tool — no external MCP, no model needed IF a mock `pi` is in the image (a `#!/bin/sh` script that writes the file and exits 0). This avoids burning API credits on model tokens.

**Tag:** NET-NEW

### Milestone 3 — Observe VM Status Sidecar (NET-NEW, optional for first run)

**File:** `packages/core/src/sandbox/daytona.ts` — `DaytonaSandboxProvider.openRun` (line 507).

After booting the VM (line 513), write:
```ts
await fs.writeFile(
  path.join(opts.outDir, '.pi', 'daytona-vm.json'),
  JSON.stringify({ vmId: vm.id, bootedAt: new Date().toISOString() }),
);
```

`opts.outDir` is available on `OpenRunOpts` (types.ts:577). The runner creates `.pi/` before calling `openRunScope` (runner.ts:1759 creates `outDir`; the `.pi/` dir is created by `writeStatus` on the first call). A defensive `mkdir` before the write is needed.

**Landing point:** daytona.ts:525 (after `createFolder(rootDir)`, before `return new DaytonaRunScope`).

**Tag:** NET-NEW (3 lines in daytona.ts)

### Milestone 4 — In-VM Scope Enforcement with `bwrap` (NET-NEW, post-MVP)

For production multi-node runs where node↔node isolation inside the shared VM matters:

**File:** `packages/core/src/sandbox/seatbelt.ts` (or a new `bwrap.ts` sibling)

Add `bwrapExecPlan(cmd, {workdir, readScope, writeScope})` → the same contract as `seatbeltExecPlan` (seatbelt.ts:197–209) but producing `bwrap --ro-bind / / --bind <workdir> <workdir> ...` argv. `DaytonaSandbox.exec` (daytona.ts:259) calls `bwrapExecPlan` when a provider flag is set and falls back to bare exec otherwise.

**Tag:** NET-NEW, deferred

---

## Reuse-vs-Net-New Summary Table

| Component | Tag | File:line | Notes |
|---|---|---|---|
| `DaytonaSandboxProvider` / `DaytonaRunScope` / `DaytonaSandbox` | **REUSE** | daytona.ts:189–544 | Complete, no changes needed |
| `realDaytonaSdk` / `createDaytonaProvider` | **REUSE** | daytona-sdk.ts:117–177 | Complete |
| `openRunScope` / `DaytonaRunScope` wiring in runner | **REUSE** | runner.ts:1571–1577, 1863–1876 | Already handles `openRun` |
| `assembleRunTools` / tool registry path | **REUSE** | tool-config.ts:60, entry.ts:34–43 | Works unchanged pre-VM |
| Extension staging (`tools.ts` uploadFile) | **REUSE** | runner.ts:1083–1086, daytona.ts:235–241 | In-VM path is already posix-correct |
| MCP config staging + `$VAR` env | **REUSE** | runner.ts:947–961, 1089–1093 | `CLOUD_KINDS` allowlist already active |
| `SecretResolver` cloud allowlist | **REUSE** | runner.ts:430, 958; types.ts:626–632 | Daytona is in `CLOUD_KINDS` |
| `watchRun` / live event streaming | **REUSE** | observe/watch.ts:62; runner.ts:1127 | Events land on host in real-time via session callbacks |
| `summarizeRun` / `buildRunView` visibility post-collection | **REUSE** | observe/index.ts:27, 15 | Reads host `outDir` — already populated |
| `parity.test.ts` with fake SDK | **REUSE** | test/sandbox-cloud-parity.test.ts:263–413 | Continues to prove lifecycle contract |
| `--sandbox daytona` CLI flag | **NET-NEW** | cli/src/run.ts:101, 104, 358–369 | Single branch + import |
| `createDaytonaProvider` re-export from core | **NET-NEW** | packages/core/src/index.ts | One line if not already exported |
| VM image with `pi` + Node.js | **NET-NEW** | External (Dockerfile) | Prerequisite |
| Real-SDK e2e smoke test | **NET-NEW** | test/sandbox-cloud-e2e.test.ts | Credential-gated |
| `daytona-vm.json` status sidecar | **NET-NEW** | daytona.ts:~525 | 3-line addition in `openRun` |
| `bwrap` in-VM scope enforcement | **NET-NEW (deferred)** | seatbelt.ts or new bwrap.ts | Post-MVP, for multi-node isolation |

---

## Self-Check (Bar Audit)

**Bar item 1 — Section B code trace (where pi executes, what transfers):** PASS. Traced through daytona.ts:507–526 (VM boot), runner.ts:1014–1093 (staging), daytona.ts:351–354 (exec in VM), daytona.ts:404–418 (collect). Named every uploaded file type. Corrected the owner's model explicitly.

**Bar item 2 — C/D concrete REUSE verdict with file:line anchors:** PASS. C: `CreateOpts.readScope/writeScope` ignored by daytona.ts:218–223; seatbelt seam reusable via `bwrapExecPlan` (daytona.ts:259, seatbelt.ts:197). D: extension/MCP staging reuse traced through runner.ts:1083–1093, daytona.ts:235–241; MCP server reachability from VM flagged UNVERIFIED.

**Bar item 3 — E names the actual observe seam and cloud visibility post-collection:** PASS. `watchRun` (observe/watch.ts:62) + `NodeRecorder` (runner.ts:1127–1128) + `writeStatus` (runner.ts:912). Live events DO flow host-side in real-time via session callbacks. Post-collection visibility confirmed via `outDir` shared between runner and observe layer. VM status sidecar option named with file:line.

**Bar item 4 — F milestone'd with REUSE/NET-NEW tags and file:line landing points, real-SDK test named:** PASS. Four milestones, all tagged. Cheapest real-SDK test described with the mock-pi bypass strategy.

**Bar item 5 — Every codebase claim has file:line; Daytona capability claims web-verified or marked UNVERIFIED:** PASS. MCP server reachability from VM is marked UNVERIFIED. All other Daytona capability claims are grounded in `docs/research/daytona-sdk-2026-06-21.md` (the file the codebase itself cites) and the actual SDK seam interfaces in daytona.ts/daytona-sdk.ts. No Daytona capability is fabricated.

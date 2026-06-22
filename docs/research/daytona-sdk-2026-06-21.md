# Daytona TypeScript SDK — verified signatures for the live wiring (2026-06-21)

Grounding for making `sandbox/daytona.ts` LIVE. Every row is backed by an official-docs or OSS URL.
Phase-1 RESEARCH artifact for the `feat/daytona-live` task.

## 0. The package: `@daytona/sdk` (NOT `@daytonaio/sdk`)

**Critical divergence from the task brief.** The package was RENAMED. `@daytonaio/sdk` is now a
deprecated stub that only prints "use `@daytona/sdk` instead" — the real, maintained SDK is
**`@daytona/sdk`**. The API is identical; only the name changed. We import `@daytona/sdk`.

- npm (old, deprecated): https://www.npmjs.com/package/@daytonaio/sdk — banner: *"@daytonaio/sdk is now @daytona/sdk … Please use `@daytona/sdk` instead."*
- npm (current): https://www.npmjs.com/package/@daytona/sdk
- repo: https://github.com/daytonaio/daytona
- docs: https://www.daytona.io/docs/en/typescript-sdk/

**Pinned version: `@daytona/sdk@^0.185.0`** (latest stable, published 2026-06-09; `0.184.0` is the prior
stable). Ships dual ESM/CJS, works in Node ≥ out-of-the-box. Uses Node `Buffer` for binary payloads
(`fs.downloadFile` returns a `Buffer`).

Auth/config (`new Daytona(config?: DaytonaConfig)`): `apiKey?`, `apiUrl?` (default
`https://app.daytona.io/api`, env `DAYTONA_API_URL`), `target?`, `organizationId?`/`jwtToken?` for JWT auth,
`otelEnabled?`. With no config it reads `DAYTONA_API_KEY` / `DAYTONA_API_URL` / `DAYTONA_TARGET` from env.
Constructor THROWS if neither API key nor JWT is available.
Source: https://www.daytona.io/docs/en/typescript-sdk/daytona/

## 1. Signature table — our seam method → real `@daytona/sdk` call → source

| Seam / draft site | Real SDK signature | Source |
|---|---|---|
| `new Daytona({ apiKey })` | `new Daytona(config?: DaytonaConfig)` — `{ apiKey?, apiUrl?, target?, organizationId?, jwtToken?, otelEnabled? }` | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| `daytona.create(params)` → `DaytonaVm` | `daytona.create(params?, options?: { timeout?: number; onSnapshotCreateLogs?: (c)=>void }): Promise<Sandbox>` | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| create params: `image` | `CreateSandboxFromImageParams.image: string \| Image` (string image ref OR declarative `Image` builder) | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| create params: `envVars` | `envVars?: Record<string,string>` ✅ (draft name correct) | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| create params: `resources {cpu,memory,disk}` | `resources?: Resources` = `{ cpu?, memory?, disk?, gpu?, gpuType? }` — **memory/disk in GiB**, cpu in cores ✅ | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| create params: `autoStopInterval` | `autoStopInterval?: number` — **MINUTES** (0 = disabled, default 15) ✅ draft's "minutes" assumption correct | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| (extra, available) | also `autoArchiveInterval?`, `autoDeleteInterval?`, `ephemeral?`, `labels?`, `language?`, `name?`, `user?`, `volumes?`, `networkBlockAll?`, `networkAllowList?` | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) |
| `vm.id` | `Sandbox.id: string` ✅ | [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/) |
| `vm.fs` | `Sandbox.fs: FileSystem` ✅ | [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/) |
| `vm.process` | `Sandbox.process: Process` ✅ | [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/) |
| `fs.uploadFile(Buffer, remotePath)` | `uploadFile(file: Buffer, remotePath: string, timeout?: number): Promise<void>` ✅ (takes a **Buffer**, not a path, in the overload we use) | [file-system](https://www.daytona.io/docs/en/typescript-sdk/file-system/) |
| `fs.downloadFile(remotePath) → Buffer` | `downloadFile(remotePath: string, timeout?: number): Promise<Buffer>` ✅ | [file-system](https://www.daytona.io/docs/en/typescript-sdk/file-system/) |
| `fs.createFolder(path, mode)` | `createFolder(path: string, mode: string): Promise<void>` — **`mode` is REQUIRED** (octal string e.g. "755") | [file-system](https://www.daytona.io/docs/en/typescript-sdk/file-system/) |
| `fs.findFiles(root, pattern) → {file}[]` (DRAFT) | ❌ **WRONG.** `findFiles(path, pattern): Promise<Match[]>` is a **grep** (text search inside files) returning `{file, line, content}[]`. The "list files by NAME glob" method is **`searchFiles(path, pattern): Promise<SearchFilesResponse>`** where `SearchFilesResponse = { files: string[] }`. | [file-system](https://www.daytona.io/docs/en/typescript-sdk/file-system/) |
| `process.executeCommand(cmd, cwd?, env?, timeoutSec?)` → `{exitCode, result}` | `executeCommand(command, cwd?, env?, timeout?): Promise<ExecuteResponse>` ✅ POSITIONAL, **timeout in SECONDS**. Returns `{ exitCode, result, artifacts: { stdout, charts } }`. `result` == stdout. | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) |
| `process.createSession(sessionId)` | `createSession(sessionId: string): Promise<void>` ✅ | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) |
| `process.executeSessionCommand(sessionId, {command, runAsync})` → `{cmdId}` | `executeSessionCommand(sessionId, req: SessionExecuteRequest, timeout?): Promise<SessionExecuteResponse>`. Req = `{ command, runAsync?, suppressInputEcho? }`. Response = `{ cmdId, output?, stdout?, stderr?, exitCode? }` (exitCode/output only populated for SYNChronous, i.e. `runAsync:false`). ✅ draft shape close; `cmdId` is non-optional on the response. | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) · [log-streaming](https://www.daytona.io/docs/en/log-streaming.md) |
| `process.getSessionCommandLogs(sessionId, cmdId, onStdout?, onStderr?)` | TWO overloads. (a) `getSessionCommandLogs(sessionId, commandId): Promise<SessionCommandLogsResponse>` → `{ output?, stdout?, stderr? }` (buffered snapshot). (b) `getSessionCommandLogs(sessionId, commandId, onStdout, onStderr): Promise<void>` (STREAMING, resolves when the cmd ENDS, **returns void** — NOT a `{stdout,stderr}` object). ❌ draft assumed ONE method that both streams AND returns `{stdout,stderr}`. | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) |
| `process.getSessionCommand(sessionId, cmdId)` → exit code | `getSessionCommand(sessionId, commandId): Promise<Command>` → `{ id, command, exitCode? }`. **This is how you get the real exit code after a `runAsync` command finishes** (draft's "a production impl would poll session-command status for the code"). | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) |
| `process.deleteSession(sessionId)` | `deleteSession(sessionId: string): Promise<void>` ✅ | [process](https://www.daytona.io/docs/en/typescript-sdk/process/) |
| `daytona.delete(vm)` (DRAFT) | `delete(sandbox: Sandbox, timeout?: number): Promise<void>` ✅ EXISTS. Also `sandbox.delete(timeout?)`. We keep `daytona.delete(vm)` (draft's choice). | [daytona](https://www.daytona.io/docs/en/typescript-sdk/daytona/) · [sandbox](https://www.daytona.io/docs/en/typescript-sdk/sandbox/) |

## 2. Draft `// DRAFT:` assumptions — RIGHT vs WRONG

RIGHT (confirmed, comment upgraded to "live"):
- `envVars`, `resources {cpu,memory,disk}`, `autoStopInterval` (minutes) on create — all correct names/units.
- `executeCommand(cmd, cwd?, env?, timeoutSec?)` positional, timeout in **seconds**, returns `{exitCode, result}` (combined-ish: `result` = stdout). Correct.
- `uploadFile(Buffer, remotePath)` / `downloadFile(remotePath) → Buffer`. Correct.
- `daytona.delete(vm)` exists. Correct.
- session lifecycle `createSession` / `executeSessionCommand({command, runAsync})` / `deleteSession`. Correct.
- `Sandbox.id`. Correct.

WRONG (seam fixed in this task):
1. **`findFiles` → `searchFiles`.** The draft used `findFiles(root,'*')` expecting `{file}[]` file paths.
   `findFiles` is grep; the right call is `searchFiles(path, pattern): { files: string[] }`. Seam method
   renamed `findFiles → searchFiles`, return type changed `{file}[]` → `{ files: string[] }`. Provider's
   `downloadDir` updated to iterate `result.files` (a `string[]`).
2. **`getSessionCommandLogs` does NOT return `{stdout,stderr}` in its streaming form.** The streaming
   overload (with callbacks) resolves `void`. The draft both passed callbacks AND read the resolved
   `{stdout,stderr}` — impossible against the real overloads. Adapter fix: in the streaming path, accumulate
   stdout/stderr inside the `onStdout`/`onStderr` callbacks ourselves; after the streaming promise resolves,
   call `getSessionCommand(sessionId, cmdId)` for the **real exit code**. Seam's `getSessionCommandLogs`
   return changed to `Promise<void>` (callbacks own the bytes); a new seam method `getSessionCommand(sessionId,
   cmdId) → { exitCode?: number }` supplies the exit code.
3. **`createFolder` `mode` is required**, not optional. Seam keeps `mode?` optional but the ADAPTER always
   passes a default `'755'` to the real call (real signature requires the 2nd arg).

## 3. Auth/config the live factory needs

`createDaytonaProvider({ apiKey?, image?, resources?, autoStopInterval?, homeDir? })`:
- `apiKey` → `new Daytona({ apiKey })`. If omitted, the real client falls back to `DAYTONA_API_KEY` env
  (and throws if that's also missing). The factory passes `apiKey` through only when defined so env-based
  auth keeps working.
- `image`, `resources`, `autoStopInterval`, `homeDir` → the provider's `vmDefaults` (run-level VM config the
  per-node `CreateOpts` can't carry — OpenRunOpts has no image/resources).
- `homeDir` default `/home/daytona` (Daytona's default sandbox user home; `getUserHomeDir()` confirms this
  shape). Run root nests at `<homeDir>/pi/<run>`.

## 4. OSS references (proven usage patterns copied into the adapter)

- **Daytona Codex SDK interactive-terminal guide** — the canonical session streaming + teardown pattern we
  mirror in `execSession`:
  https://www.daytona.io/docs/en/guides/codex/codex-sdk-interactive-terminal-sandbox.md
  ```ts
  await sandbox.process.createSession(sessionId)
  const command = await sandbox.process.executeSessionCommand(sessionId, { command, runAsync: true })
  if (!command.cmdId) throw new Error('Failed to start agent command')
  await sandbox.process.getSessionCommandLogs(sessionId, command.cmdId, onStdout, onStderr)
  await sandbox.process.deleteSession(sessionId)
  ```
- **Daytona log-streaming docs** — confirms the streaming form takes `command.cmdId!` + callbacks, and that
  the buffered form (no callbacks) returns `{ stdout, stderr, output }`:
  https://www.daytona.io/docs/en/log-streaming.md
- **Daytona code-execution example (mintlify mirror)** — `createSession` → `executeSessionCommand` →
  `getSessionCommand(sessionId, cmdId)` → `getSessionCommandLogs(sessionId, cmdId)` → `deleteSession`,
  proving `getSessionCommand` is the exit-code source:
  https://daytonaio-daytona.mintlify.app/examples/code-execution
- **Buffered exec + delete** (getting-started): `const r = await sandbox.process.executeCommand('echo hi'); console.log(r.result); await sandbox.delete()`:
  https://www.daytona.io/docs/en/getting-started.md
- **GitHub source of the docs** (file-system / process .mdx, the authoritative signatures):
  https://github.com/daytonaio/daytona/blob/main/apps/docs/src/content/docs/en/typescript-sdk/file-system.mdx

## 5. Residual uncertainties (flagged, not papered over)

- **Per-command exit code on `runAsync`.** Real exit code comes from `getSessionCommand(sessionId, cmdId)`
  AFTER the streaming-logs promise resolves. On an ABORTED command we tear the session down, so
  `getSessionCommand` may not answer — the adapter reports 124 (runner kill convention) on abort and falls
  back to 1 if the post-finish `getSessionCommand` lookup fails. Not verifiable offline; covered by the manual
  live smoke-test.
- **Process-group SIGTERM→SIGKILL.** Daytona exposes NO per-session-command process-group kill. `deleteSession`
  is the only interrupt; it's a SOFT cancel. The seam's `ExecOpts.signal` contract (SIGTERM→SIGKILL of the
  process group) is satisfied only at the session-teardown granularity; the runner's `killGrace` liveness
  timer remains the hard backstop. (Unchanged from the draft's §e analysis — still accurate.)
- **Per-node image in the shared-VM (run-scoped) path is UNSUPPORTED** — you can't re-image a running VM per
  node. Per-node `image` works only in the non-scoped `provider.create` throwaway-VM path. (Unchanged.)

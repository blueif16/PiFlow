# Cloud sandbox providers — SDK/API shapes for the Pi Flow `SandboxProvider` interface

> Research brief · 2026-06-21 · for designing **one** provider interface that local (in-memory temp, macOS
> Seatbelt) and cloud (Daytona, E2B, …) execution backends all satisfy. Each node in a Pi Flow DAG runs one
> headless `pi` agent inside a sandbox: (a) workspace dir, (b) declared read scope, (c) write/output scope,
> (d) run-a-command + capture stdout/stderr/exit, (e) collect artifacts back out.
>
> Scope: the **sandbox-execution** use case only (not generic PaaS hosting). Method names are quoted from
> official docs; anything not directly confirmed is marked **unclear** with the source consulted.

---

## TL;DR fit table

| Platform | TS/JS SDK (pkg) | create | put files in | exec → {out,err,code} | read out | dispose | read-scope model | cold-start | fork/snapshot |
|---|---|---|---|---|---|---|---|---|---|
| **Daytona** | yes — `@daytona/sdk` (was `@daytonaio/sdk`) | `daytona.create()` | `fs.uploadFile(s)` / `git.clone` | `process.executeCommand` → `.result/.exitCode`; sessions for bg | `fs.downloadFile` | `sandbox.delete()` | whole-sandbox (Docker container); no in-sandbox read ACL | **~90ms** (down to ~27ms, pre-warmed) | snapshot + **fork** (COW) |
| **E2B** | yes — `@e2b/code-interpreter` / `e2b` | `Sandbox.create()` | `files.write(path,data)` / array | `commands.run` → `{stdout,stderr,exitCode}`; `background:true` | `files.read(path,{format})` | `sandbox.kill()` | whole-sandbox (Firecracker microVM) | **~150ms** | beta pause/resume; `Sandbox.connect` |
| **Modal** | **Python-first**; JS SDK exists (`modal` / libmodal, beta) | `Sandbox.create(app,image)` | `Image.add_local_dir` / `fs.copy_from_local` / Volume | `sb.exec(*args)` → `ContainerProcess` (`.stdout.read()`, `.returncode`) | `fs.copy_to_local` / `read_bytes` | `sb.terminate()` | whole-sandbox + **Volume sub_path** scoping | seconds (image-dependent) | `snapshot_filesystem`, dir snapshots |
| **Vercel Sandbox** | yes — `@vercel/sandbox` | `Sandbox.create()` | `writeFiles([{path,content}])` / `source:{type:'git'}` | `runCommand(cmd,args)` → `.exitCode`/`await .stdout()`; `detached:true` | `readFile` / `downloadFile` / `readFileToBuffer` | `sandbox.stop()` | whole-sandbox (Firecracker microVM) | seconds | persistent-by-default snapshot on stop |
| **Cloudflare Sandbox** | yes — `@cloudflare/sandbox` (Workers-only) | `getSandbox(ns,id)` | `writeFile` / `mkdir` / `git.clone` | `exec(cmd)` → `{stdout,stderr,exitCode,success}`; `startProcess` bg | `readFile` | `sandbox.destroy()` | whole-sandbox (container/DO) | first build 2-3min, then warm | dir backup/restore; S3 mount |
| **Runloop** | yes — `@runloop/api-client` | devbox create | dedicated file iface (read/write) | `devbox.cmd.exec()` → exit/stdout/stderr | file iface read | suspend/snapshot/delete | whole-VM (micro-VM) | seconds | disk snapshot, suspend/resume |
| **Morph** | yes — `morphcloud` | `client.instances.start` | SSH + `instance copy` CLI; sync via exec | `instance.exec()` → `{exit_code,stdout,stderr}` | SSH/copy | stop/snapshot | whole-VM (full VM) | snapshot/branch **~250ms** | **Infinibranch** mem+disk `instance.branch(n)`, nested |
| **Fly Machines** | REST API (no first-party sandbox SDK) | `POST /v1/.../machines` | bake into image / volume | `machines exec` API | volume / API | `DELETE` machine | whole-VM (Firecracker) | sub-second resume from stopped | volumes; not a fork primitive |

*Local backends we already have:* **in-memory/temp** (a `mkdtemp` dir) and **Seatbelt** (`sandbox-exec` over a temp
workspace + optional git worktree). Neither has a remote SDK — they satisfy the same interface in-process.

---

## 1. Daytona — `@daytona/sdk` (priority; user is evaluating)

**The closest 1:1 to the interface we want.** Docker-container sandboxes purpose-built for "AI-generated code,"
with an explicit FileSystem / Process / Git toolbox in the TS SDK.

- **Auth / create.** Env `DAYTONA_API_KEY` (also `DAYTONA_API_URL`, `DAYTONA_TARGET`), or constructor opts
  `{ apiKey, apiUrl, target }`.
  ```ts
  import { Daytona } from '@daytona/sdk';
  const daytona = new Daytona();
  const sandbox = await daytona.create();                       // default
  // or: daytona.create({ language:'typescript', image, snapshot, envVars,
  //                       resources, autoStopInterval, autoArchiveInterval,
  //                       autoDeleteInterval, volumes, ephemeral, public })
  ```
  Package renamed `@daytonaio/sdk` → `@daytona/sdk` (identical API, no breaking change). [npm](https://www.npmjs.com/package/@daytonaio/sdk) · [TS SDK ref](https://www.daytona.io/docs/en/typescript-sdk/)
- **Workspace in.** `sandbox.fs.uploadFile()` / `uploadFiles()`, `fs.createFolder()`, or
  `await sandbox.git.clone('https://…','/home/daytona/repo')`. [getting-started](https://www.daytona.io/docs/en/getting-started/)
- **Exec.** `const r = await sandbox.process.executeCommand('echo hi'); r.result` (stdout) + exit code;
  `sandbox.process.codeRun('console.log(1)')` runs code directly. **Background / long-running:**
  `createSession()` → `executeSessionCommand()` → `getSessionCommandLogs()`. [SDK README](https://github.com/daytonaio/sdk)
  Separate `stdout`/`stderr` field split on `executeCommand` is **unclear** from docs (`.result` is shown); the
  session API is the documented path for streaming logs.
- **Read out.** `sandbox.fs.downloadFile()` (note: throws in runtimes lacking Buffer polyfills), `listFiles()`.
- **FS scoping.** Whole-sandbox isolation: the sandbox is the boundary, so "read scope" = whatever you upload /
  clone. No in-sandbox per-path read ACL. Isolation is Docker/OCI by default (shared kernel), optional **Kata**
  containers for hardware VM isolation. [morphllm comparison](https://www.morphllm.com/comparisons/daytona-alternative)
- **Persistence / fork.** States Running → Stopped → Archived → Deleted. `snapshot()`/SnapshotService for reusable
  templates; **`fork()`** = copy-on-write clone of a sandbox's filesystem (independent from fork point). Stopped
  keeps filesystem; Archived moves FS to object storage. [pricing/lifecycle](https://www.daytona.io/pricing)
- **Lifecycle / cost.** Default auto-stop **15 min** idle, auto-archive **7 days** stopped; all three intervals
  configurable (minutes; `0`/`-1` semantics being standardized — [issue #3354](https://github.com/daytonaio/daytona/issues/3354)).
  Cold-start **sub-90ms** (pre-warmed pools, as low as ~27ms). **$200 free compute + 5GB storage, no card**;
  ~$0.067/hr for 1 vCPU/1 GiB running, storage-only when stopped, pure usage-based (no base fee).
- **Dispose.** `await sandbox.delete()`.

## 2. E2B — `@e2b/code-interpreter` (or base `e2b`) (priority)

Firecracker-microVM sandboxes; the reference "run AI-generated code" SDK. Two layers: `runCode()` (stateful
kernel, Jupyter-style) and `commands.run()` (shell).

- **Auth / create.** Env `E2B_API_KEY`. `const sbx = await Sandbox.create({ timeout, metadata, envs, /* template */ })`
  (timeout in ms). [quickstart](https://e2b.dev/docs/quickstart) · [npm](https://www.npmjs.com/package/@e2b/code-interpreter)
- **Workspace in.** `await sbx.files.write('/path', content)` single; `sbx.files.write([{path,data}])` batch;
  pre-signed `sbx.uploadUrl()` for browser. [filesystem](https://e2b.dev/docs/filesystem/upload)
- **Exec.** `import { Sandbox } from 'e2b'; const r = await sbx.commands.run('echo hi')` → `r.stdout`, `r.stderr`,
  `r.exitCode`. Streaming via `onStdout`/`onStderr` callbacks. **Background process:** `commands.run(cmd,{background:true})`
  returns a `CommandHandle` (kill/wait later). [commands](https://e2b.dev/docs/commands) — exact `CommandResult`
  field names confirmed as `{stdout,stderr,exitCode}` in v1; the v0 `e2b`/`e2b-code-interpreter` packages are
  **deprecated**, use v1.
- **Read out.** `await sbx.files.read('/path', { format: 'text'|'bytes'|'stream' })`; `sbx.files.list('/')`.
- **FS scoping.** Whole-microVM; 1GB FS (Hobby) / 5GB (Pro). No per-path read ACL — read scope = what you upload.
  Hardware (Firecracker) isolation.
- **Lifecycle.** `sbx.setTimeout(ms)` extends; `sbx.kill()` tears down. **Reconnect:** `Sandbox.connect(sandboxId)`.
  **Beta pause/resume** for persistence (exact method name `betaPause`/`pause` **unclear** — v1 SDK ref page did not
  expose it; confirm against current docs). Cold-start **~150ms**.
- **Cost.** Usage-based; Pro tier has a **$150/mo** base for longer sessions / higher concurrency (per ZenML/Daytona
  comparisons). [zenml E2B vs Daytona](https://www.zenml.io/blog/e2b-vs-daytona)
- **Dispose.** `await sbx.kill()`.

## 3. Modal Sandboxes — `modal` (Python-first; JS SDK in beta)

VM-backed sandboxes inside Modal Apps. The richest **process model** (asyncio-subprocess-like) but the SDK is
Python-primary; JS exists via `modal-labs/libmodal` (`modal-js`) and is newer/thinner. [sandboxes guide](https://modal.com/docs/guide/sandboxes)

- **Create.** `sb = modal.Sandbox.create(app=app, image=image, timeout=300, idle_timeout=…, volumes={…})`.
  Image declares deps: `modal.Image.debian_slim().pip_install("numpy").add_local_dir(local,'/app')`.
- **Workspace in.** Bake into the Image (`add_local_dir`), or at runtime `sb.fs.copy_from_local(local, '/abs')`,
  or mount a **Volume** (persists across runs). [files](https://modal.com/docs/guide/sandbox-files)
- **Exec.** `p = sb.exec("bash","-c","…")` → `ContainerProcess`: `p.stdout.read()` (blocks for full output) or
  iterate `for line in p.stdout` (stream); `p.wait()`; exit code `p.returncode`. `stdout=StreamType.PIPE|STDOUT`.
  Every `exec` is effectively a background process; `p.poll()` checks without blocking. [exec](https://modal.com/docs/guide/sandbox-spawn)
- **Read out.** `sb.fs.copy_to_local('/abs', local)`, `read_bytes`/`read_text`, `list_files`, `watch`.
- **FS scoping.** Whole-sandbox, **plus** the one finer-grained primitive here: a Volume can be mounted with
  `vol.with_mount_options(sub_path='/users/u123')` so a sandbox sees only its subtree — closest cloud analog to a
  declared write/output scope. Volume files sync back **only on terminate** (CloudBucketMount syncs continuously).
- **Lifecycle.** Default `timeout=300s` (max lifetime), `idle_timeout` for inactivity. `sb.terminate(wait=True)`
  returns exit code. `snapshot_filesystem()` and directory snapshots → mountable Images. **Caveat:** cannot
  snapshot while an `exec` is running; bg processes aren't restored after snapshot.
- **TS fit.** `modal-js`/libmodal mirrors `Sandbox.create`/`exec`/`terminate` but is beta — treat as a thinner
  surface than Python. [libmodal exec example](https://github.com/modal-labs/libmodal/blob/main/modal-js/examples/sandbox-exec.ts)

## 4. Vercel Sandbox — `@vercel/sandbox` (GA 2026-01-30)

Firecracker microVMs, clean TS-native surface, but Node-22+ and **OIDC-token** auth oriented around Vercel.

- **Create.** `const sandbox = await Sandbox.create({ runtime:'node24', timeout:60_000, resources:{vcpus:4},
  ports:[3000], source:{type:'git',url}, persistent:false })`. Auth: Vercel OIDC token (local: `vercel env pull`,
  12h expiry). [sdk-reference](https://vercel.com/docs/sandbox/sdk-reference)
- **Workspace in.** `await sandbox.writeFiles([{path,content:Buffer.from(…),mode}])`; `sandbox.mkDir()`;
  `source:{type:'git',url}` clones at create. Default cwd `/vercel/sandbox`.
- **Exec.** `const r = await sandbox.runCommand('node',['hello.js'])` → `r.exitCode`, `await r.stdout()`,
  `await r.stderr()`. **Background:** `runCommand({detached:true,…})` returns a `Command`; `exitCode` is `null`
  until `await command.wait()`. `sudo:true`, `cwd`, `env` supported.
- **Read out.** `readFile` (→ ReadableStream, `null` if absent), `readFileToBuffer`, `downloadFile` (to local).
- **FS scoping.** Whole-microVM. **Persistent by default** (snapshots FS on `stop`, restores on resume);
  `persistent:false` for ephemeral. Up to 8 vCPU / 2GB-per-vCPU / 4 ports.
- **Lifecycle.** Default 5-min timeout; max 45 min (Hobby) / 5 h (Pro/Ent), extendable. `sandbox.stop()`.
  `sandbox.domain(port)` for a public preview URL.

## 5. Cloudflare Sandbox — `@cloudflare/sandbox` (Workers + Containers + Durable Objects)

Only callable **from inside a Worker** — the `Sandbox` is a Durable Object you re-export. Great DX, but the
runtime model (no plain Node process; needs Docker locally to *build*) makes it the worst fit for our Node driver.

- **Create / address.** `const sandbox = getSandbox(env.Sandbox, 'user-123', { sleepAfter, keepAlive,
  containerTimeouts, normalizeId })` — created on first reference to a stable ID. [get-started](https://developers.cloudflare.com/sandbox/get-started/)
- **Workspace in.** `sandbox.mkdir('/workspace/x',{recursive:true})`, `sandbox.writeFile(path, contents)`,
  `git.clone`, S3 bucket mount.
- **Exec.** `const r = await sandbox.exec('python3 -c "print(4)"')` → `{stdout, stderr, exitCode, success}`;
  `execStream()` streams; `startProcess()` for background services. [execute-commands](https://developers.cloudflare.com/sandbox/guides/execute-commands/)
- **Read out.** `sandbox.readFile(path)`; dir backup/restore.
- **Scoping / lifecycle.** Whole-container; **ephemeral** — sleeps after 10-min idle (`sleepAfter`), state **lost**
  on next request unless `keepAlive:true` (then must `destroy()`). `/workspace`,`/tmp`,`/home` persist while warm.
- **Dispose.** `sandbox.destroy()`.

## 6. Runloop & Morph (brief — the snapshot/fork specialists)

- **Runloop** — `@runloop/api-client`. Enterprise coding-agent devboxes (micro-VM, SOC2, 10k+ parallel).
  `devbox.cmd.exec()` blocks → exit/stdout/stderr; dedicated file read/write iface; `suspend()`/`resume()` + disk
  **snapshot**, restore many devboxes from one baseline. Blueprints, SWE-bench scenarios, Agent Gateway / MCP Hub
  for credential-free tool access. [docs](https://docs.runloop.ai/docs/devboxes/overview) · [ts client](https://github.com/runloopai/api-client-ts)
- **Morph** — `morphcloud`. Built around **Infinibranch**: `instance.branch(n)` snapshots **memory + disk** and
  forks N live copies in **~250ms**, nestable — the strongest "fork a running agent to explore N paths" primitive
  of any platform. `instance.exec()` → `{exit_code,stdout,stderr}`; files via SSH + `instance copy` CLI (no rich
  files API); `exposeHttpService(name,port)`. [morph SDK](https://github.com/morph-labs/morph-typescript-sdk) · [branch](https://cloud.morph.so/docs/documentation/instances/branch)
- **Fly Machines** (one-liner) — no first-party *sandbox* SDK; a REST Machines API (`POST …/machines`, `machines
  exec`, sub-second resume-from-stopped, volumes). Usable but you build the sandbox abstraction yourself; lower
  priority than the above.

---

## Synthesized proposal — the `SandboxProvider` interface

**Design stance.** Every cloud platform converges on the same five verbs — **create · put files · exec
(→ stdout/stderr/exit) · read files · dispose** — so the common shape is real and small. The *only* axis where
they genuinely diverge is **read-scope granularity**, and the answer is uniform: cloud sandboxes have **no
in-sandbox per-path read ACL**. The whole sandbox *is* the boundary, so "read scope" is enforced by **what you
upload/clone into it**, not by a deny-then-allow policy. This is the inverse of Seatbelt (which starts from the
real FS and *subtracts* reads). That asymmetry is the one thing the interface must name explicitly.

```ts
/** One node's execution sandbox. Local (temp, Seatbelt) and cloud (Daytona, E2B, …) all implement this. */
export interface SandboxProvider {
  /** Provision an ephemeral sandbox + a working dir the node owns. */
  create(opts: CreateOpts): Promise<Sandbox>;
}

export interface CreateOpts {
  /** Read scope the node DECLARES it needs. Seatbelt enforces it as a policy;
   *  cloud backends enforce it by ONLY uploading these paths (see putFiles). */
  readScope?: string[];
  /** Dedicated output dir the agent owns; collected back out via downloadDir. */
  outputDir?: string;            // default e.g. /work/out
  workdir?: string;              // default /work
  image?: string;                // cloud: base image/snapshot. local: ignored.
  env?: Record<string, string>;
  timeoutMs?: number;            // max lifetime / idle teardown
  label?: string;                // node id, for tracing
}

export interface Sandbox {
  readonly id: string;
  readonly workdir: string;

  /** Stage files in. Cloud: upload/clone (THIS is how read scope is realized).
   *  Local: copy into temp / no-op for Seatbelt (reads the real FS in readScope). */
  putFiles(files: Array<{ path: string; data: Uint8Array | string }>): Promise<void>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;

  /** Run to completion; capture streams + code. onStdout/onStderr for live streaming. */
  exec(cmd: string, opts?: ExecOpts): Promise<ExecResult>;
  /** Optional: long-running/background process; not every backend supports it cleanly. */
  spawn?(cmd: string, opts?: ExecOpts): Promise<ProcessHandle>;

  readFile(path: string, opts?: { encoding?: 'utf8' | 'binary' }): Promise<Uint8Array | string>;
  /** Collect artifacts back out — typically the outputDir. */
  downloadDir(remoteDir: string, localDir: string): Promise<void>;

  dispose(): Promise<void>;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}
export interface ExecResult { stdout: string; stderr: string; code: number; }
export interface ProcessHandle {
  pid?: string;
  wait(): Promise<ExecResult>;
  kill(): Promise<void>;
}
```

### Per-backend mapping (and where it breaks)

| Method | in-mem/temp | Seatbelt-local | Daytona | E2B |
|---|---|---|---|---|
| `create` | `mkdtemp` | `mkdtemp` + generate `.sb` from `readScope` | `daytona.create()` | `Sandbox.create()` |
| `putFiles`/`writeFile` | `fs.writeFile` | `fs.writeFile` (or no-op; Seatbelt reads real FS) | `fs.uploadFile(s)` / `git.clone` | `files.write` |
| `exec` | `child_process` | `sandbox-exec -f policy.sb <cmd>` | `process.executeCommand` → `.result`/exit | `commands.run` → `{stdout,stderr,exitCode}` |
| `spawn` | `spawn` detached | `spawn` under `sandbox-exec` | `createSession`+`executeSessionCommand` | `commands.run({background:true})` |
| `readFile`/`downloadDir` | `fs.readFile` | `fs.readFile` | `fs.downloadFile` | `files.read` |
| `dispose` | `rm -rf` | `rm -rf` | `sandbox.delete()` | `sandbox.kill()` |

**Where platforms do NOT fit the common shape — flag these:**

1. **`readScope` is not enforceable in-sandbox on any cloud backend.** It degrades to a *staging contract*: the
   provider uploads exactly `readScope` and nothing else. Only Seatbelt (deny-all → re-allow roots) and Modal's
   Volume `sub_path` actually *enforce* a read boundary at runtime. → Keep `readScope` in the interface but
   document it as "**enforced** by Seatbelt; **realized by upload** on cloud." A local in-mem impl should assert
   the agent never reads outside `readScope` (efficient correctness check that mirrors prod behavior).
2. **Streaming vs blocking-capture differ.** E2B/Modal/Cloudflare stream natively (`onStdout`/iterate); Daytona's
   `executeCommand` returns a buffered `.result` and you reach for **sessions** to stream. → `exec` must buffer
   *and* optionally fan out to `onStdout`/`onStderr`; treat streaming as best-effort.
3. **`spawn` (background process) is uneven.** First-class on E2B (`background:true`), Modal (every `exec`),
   Cloudflare (`startProcess`), Vercel (`detached`); on Daytona it's the **session** API, not a flag. Keep
   `spawn?` **optional**; the local temp impl gets it free, Seatbelt needs care (the policy must outlive the
   parent). Do not assume snapshot survives a live bg process (Modal explicitly doesn't).
4. **Cloudflare can't be driven from a plain Node process** — it lives inside a Worker/DO and needs Docker to
   build. It satisfies the *shape* but not our *driver model*; rank it last for the first cloud impl.
5. **Separate `stdout`/`stderr`/`code` is not uniformly exposed.** Vercel splits cleanly (`exitCode`, `await
   stdout()`); Daytona's documented field is `.result` (combined) — the split is **unclear** without sessions.
   → `ExecResult` keeps all three fields; a backend that only gives combined output puts it in `stdout` and
   leaves `stderr:''`.

### The 2-3 sharpest implications for our abstraction

- **"Read scope" splits into two enforcement classes.** Local = *subtractive* (Seatbelt denies the real FS then
  re-allows roots). Cloud = *additive* (empty VM, you only put in what's allowed). The interface should carry
  `readScope` as the single declared input and let each backend pick its enforcement; never promise cloud read
  ACLs we can't deliver.
- **The output dir is the portable contract, not the read scope.** Every backend cleanly supports "agent writes
  to `outputDir`, we `downloadDir` it back" — that maps to Daytona `fs.downloadFile`, E2B `files.read`, Modal
  `copy_to_local`, Vercel `downloadFile`. Make `outputDir` + `downloadDir` the load-bearing handoff (matches Pi
  Flow's "coordination is the filesystem, artifacts by path").
- **Pick Daytona as the first cloud impl, E2B second.** Daytona's TS SDK is the tightest 1:1 (`create` /
  `fs.uploadFile` / `process.executeCommand` / `fs.downloadFile` / `delete`), has the fastest cold-start (~90ms,
  matters at fleet scale), a real `fork()` (useful for the middle-loop "branch and explore" pattern), and a free
  tier with no card. E2B is the proven second source (microVM isolation, clean `{stdout,stderr,exitCode}`).
  Defer **Modal** (Python-first, JS beta) and **Cloudflare** (Worker-bound). Keep **Morph** on the radar purely
  for its 250ms live `branch(n)` if the middle-loop ever needs fork-a-running-agent.

# PiFlow readScope Enforcement Gap Audit

**Date:** 2026-06-26
**Auditor role:** Senior security auditor — read-only, ground-truth only, every claim anchored to a file:line.
**Baseline:** `docs/research/2026-06-26-sandbox-readscope-isolation-best-practice.md`

---

## VERDICT

PiFlow's per-node `readScope` isolation is **not enforced by default on any real-run path the CLI exposes today.** The Seatbelt provider (the only OS-kernel-enforcing provider, macOS only) is fully implemented and correct — it wraps every `exec()` call in `sandbox-exec -f <profile> sh -c <cmd>`, generating a per-exec SBPL deny-all-reads-then-allow profile from `readScope` — but it is **never selected by the CLI**. The CLI's `--sandbox` flag accepts only `inmemory` (the default, no model) and `local` (the real-run provider), and `local` is a bare `spawn` with no OS restriction. The dangerous mode — bare `spawn` into the user's real working tree with full read access to `~/.ssh`, `~/.aws`, and every file on disk — is not a named escape hatch; it is the **silent default for every real run.** A node holding a shell/bash tool can `cat ~/.ssh/id_rsa` with zero OS resistance in both `local` and `worktree` modes. Write-scope (`owns`) is enforced by convention only, not by any OS mechanism. The `inject`/`reads` paths are never validated to be a subset of `readScope`; they would silently EPERM if sandboxing were turned on. The inversion of the secure-by-default principle is complete: the only kernel-enforcing provider (seatbelt) is opt-in via SDK code only, not the CLI, and isolation is off by default.

---

## PROVIDER × ENFORCEMENT MATRIX

| Provider | readScope: staged / kernel / ignored | Write-scope enforced? | Network posture | Bash-breach possible? | Evidence |
|---|---|---|---|---|---|
| `inmemory` | **IGNORED** — `readScope` passed to `CreateOpts` but `exec` is a bare `spawn(cmd, {shell:true})` | No | Unrestricted (inherits process network) | **YES** | `packages/core/src/sandbox/index.ts:49–61` — `spawn(cmd, {shell:true, env:{...process.env,...}})`, no wrapping |
| `local` | **IGNORED** — `readScope` is in `CreateOpts` (passed at `scope.create`, runner.ts:997–998) but `exec` is a bare `spawn(cmd, {shell:true})` operating in the REAL working tree | No | Unrestricted | **YES** | `packages/core/src/sandbox/local.ts:85–95` — `spawn(cmd, {cwd:this.workdir, env:{...process.env,...}, shell:true})`, no wrapping |
| `seatbelt` | **KERNEL-ENFORCED** on macOS — `exec` wraps as `sandbox-exec -f <profile> sh -c <cmd>`; profile is deny-all-reads then re-allow readScope union | No (write not covered by profile — `(allow default)` then selectively deny reads; write uses the OS write permission from the tmpdir root) | Unrestricted (`(allow default)` covers net, exec, other; only file reads are restricted) | **NO** (on macOS; see Q3) | `packages/core/src/sandbox/seatbelt.ts:221–229` — `file='sandbox-exec'; argv=['-f', profilePath, 'sh', '-c', cmd]; useShell=false` |
| `worktree` | **IGNORED** — `exec` is a bare `spawn(cmd, {shell:true})` inside the git worktree; `readScope` is in `CreateOpts` but `WorktreeSandbox.open` takes no `readScope` argument and stores none | No | Unrestricted | **YES** | `packages/core/src/sandbox/worktree.ts:93–97` — `static async open(wtPath, opts)` ignores `opts.readScope`; `exec` at line 120–130 is `spawn(cmd, {shell:true})` |
| `daytona` | **STAGED / UPLOAD CONTRACT** — the VM is an empty cloud container; `readScope` drives what the runner stages (via `putFiles`/`writeFile`) so the agent sees only what was uploaded; within the VM the agent has full read access to everything uploaded | No | Unrestricted within VM; VM network policies are Daytona-provider-level | **Partially** — within the VM, anything uploaded is readable; exfil requires network egress | `packages/core/src/sandbox/daytona.ts:211–223` — `open(sdk, vm, opts, rootDir, ownsVm)` ignores `opts.readScope`; exec via `executeCommand`/`executeSessionCommand`, no bwrap/Landlock |
| `e2b` | **NOT IMPLEMENTED** — listed in the `SandboxProviderKind` union but no provider class exists; only `NotImplementedProvider` would be returned if wired | N/A | N/A | N/A | `packages/core/src/types.ts:210` — `'e2b'` in union; `packages/core/src/sandbox/index.ts:118–125` — `NotImplementedProvider` throws on `create()` |

---

## NUMBERED FINDINGS

### Finding 1 — Per-Provider Enforcement Matrix

**inmemory** (`packages/core/src/sandbox/index.ts:49–61`)
```
exec(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      cwd: opts.cwd ? this.abs(opts.cwd) : this.workdir,
      env: { ...process.env, ...this.env, ...opts.env },
      shell: true,
```
`readScope` arrives via `CreateOpts` and is stored nowhere on `InMemorySandbox`. The `create` method (line 27–33) ignores it entirely. Classification: **IGNORED**.

**local** (`packages/core/src/sandbox/local.ts:85–95`)
Identical bare `spawn(cmd, { shell: true, env: { ...process.env, ...this.env, ...opts.env } })`. The `LocalSandbox.create` (line 58–63) resolves `opts.workdir` to an absolute path and creates the directory, but discards `opts.readScope`. Classification: **IGNORED**. Network: unrestricted (`process.env` includes all host network config; no network namespace isolation).

**seatbelt** (`packages/core/src/sandbox/seatbelt.ts:210–282`)
On `IS_DARWIN` (line 98), `exec` takes the sandboxed path (line 220–234):
```typescript
const profile = buildSeatbeltProfile({
  workdir: this.workdir,
  readScope: [...this.readScope, cwd],
});
profilePath = path.join(this.root, `exec-${process.pid}-${Date.now()}.sb`);
fsSync.writeFileSync(profilePath, profile);
file = 'sandbox-exec';
argv = ['-f', profilePath, 'sh', '-c', cmd];
useShell = false;
```
The profile (`read-scope.sb`, line 38): `(allow default)(deny file-read*)(allow file-read-metadata)` then re-allow the declared scope. Every child process (`sh`, `pi`, any spawned tool) inherits the Seatbelt policy — kernel-enforced. Classification: **KERNEL-ENFORCED** (macOS only; line 98 gates `IS_DARWIN`; on non-darwin it falls through to bare `spawn`, line 231–235, with a one-time warning at line 100–108).

**worktree** (`packages/core/src/sandbox/worktree.ts:93–164`)
`WorktreeSandbox.open(wtPath, opts)` signature takes `CreateOpts` but no field for `readScope` is read or stored. The `exec` method at line 120 is `spawn(cmd, { shell: true, env: { ...process.env, ...this.env, ...opts.env } })` — identical bare spawn. Classification: **IGNORED**. The worktree provides write isolation (a separate git checkout) but zero read isolation.

**daytona** (`packages/core/src/sandbox/daytona.ts:211–223`)
`DaytonaSandbox.open` ignores `opts.readScope`. The VM is a blank cloud container; the runner stages files into it via `writeFile`/`putFiles`, so only uploaded files are present. This is a staging contract, not an OS enforcement: if the runner stages a file outside the declared readScope (due to a bug), the agent can read it. Within the VM there is no Landlock/seccomp layer added by piflow. Classification: **STAGED (upload contract only)**. Network: VM network is Daytona-provider-level; piflow adds no egress restriction.

**e2b** — NOT IMPLEMENTED. `types.ts:210` includes `'e2b'` in `SandboxProviderKind`. The runner's `openRunScope` helper and `runWorkflow` accept it as a `SandboxProvider`, but no `E2BSandboxProvider` class exists anywhere. If a caller passed a provider of kind `'e2b'`, they would have to construct it themselves; no SDK path creates one. Classification: **NOT IMPLEMENTED**.

---

### Finding 2 — The Default Real-Run Path

**Flag parse** (`packages/cli/src/run.ts:143`):
```typescript
else if (k === '--sandbox') out.sandbox = (argv[++i] as SandboxChoice) ?? 'inmemory';
```
Default initialized at line 132: `sandbox: 'inmemory'`.

**Provider construction** (`packages/cli/src/run.ts:333`):
```typescript
const provider = parsed.sandbox === 'local' ? makeLocalProvider() : undefined;
```
When `--sandbox local` is passed, `makeLocalProvider()` is called (default at line 238: `() => new LocalSandboxProvider()`), constructing a `LocalSandboxProvider`.

When `provider` is `undefined` (the `inmemory` default), `runFromTemplate` receives no `provider` option and falls to `runner.ts`'s default (line 148–149 of `runner.ts`):
```typescript
provider?: SandboxProvider;
```
The fallback at `runWorkflow` (runner.ts ~line 1680):
```typescript
const provider = opts.provider ?? new InMemorySandboxProvider();
```

**Is seatbelt CLI-reachable?** No. The `SandboxChoice` type (`run.ts:90`) is:
```typescript
export type SandboxChoice = 'inmemory' | 'local';
```
The string `'seatbelt'` is not a valid `SandboxChoice` value, is not parsed by `parseRunArgs`, and is never passed to any provider factory. `SeatbeltSandboxProvider` is implemented in `packages/core/src/sandbox/seatbelt.ts` but is not imported by any CLI file. **Seatbelt is unreachable through `piflowctl run` in any form; it is only reachable by constructing `SeatbeltSandboxProvider` in SDK/library code.**

Summary: `piflowctl run <templateDir> --sandbox local` → constructs `LocalSandboxProvider` (bare spawn, no OS enforcement). `piflowctl run <templateDir>` (default) → constructs `InMemorySandboxProvider` (also bare spawn, intended for offline/test use, no real `pi` spawned). `readScope` is OS-enforced on **zero** CLI-reachable paths.

---

### Finding 3 — Bash-Breach

**`local` mode** (`packages/core/src/sandbox/local.ts:85–130`):
The `exec` method is `spawn(cmd, { shell: true, env: { ...process.env, ... } })` with no wrapping. When the `pi` agent (spawned via this exec) uses its bash/shell tool, the tool call translates to another shell invocation that also inherits full process environment. There is zero restriction on which paths may be read. **`bash -c 'cat ~/.ssh/id_rsa'` succeeds.** Bash-breach is possible: **YES**.

**`worktree` mode** (`packages/core/src/sandbox/worktree.ts:120–164`):
Identical bare `spawn(cmd, { shell: true, env: { ...process.env, ... } })`. The worktree is a separate git checkout for write isolation across concurrent runs, but read access is completely unrestricted. **`bash -c 'cat ~/.ssh/id_rsa'` succeeds.** Bash-breach is possible: **YES**.

**`seatbelt` mode** (`packages/core/src/sandbox/seatbelt.ts:221–234`, `read-scope.sb:38–68`):
The Seatbelt profile starts with `(deny file-read*)`, then re-allows only the declared scope + system roots. Every child `exec()` inherits the Seatbelt policy — including `sh` and any tool the agent spawns. `cat ~/.ssh/id_rsa` from inside the sandbox returns EPERM because `~/.ssh/` is not in the `(allow file-read*)` subpaths and `(allow file-read-metadata)` (line 39 of `read-scope.sb`) grants only stat/traverse, not data. Bash-breach is **NOT POSSIBLE** in seatbelt mode on macOS.

**Write-scope (`owns`) enforcement:** `owns` (the `sandbox.write` field) is carried through `NodeSpec.sandbox.write` (resolved at runner.ts:986–990) and emitted as contract markers in the prompt (`emitMarkers` call at runner.ts:1077), but there is **zero OS enforcement of the write boundary.** In `local`/`worktree` modes the agent can write anywhere the process has filesystem permission. The write boundary is prompt-convention only — bypassable by any tool call. NOT FOUND: any OS write-scope enforcement in any provider.

---

### Finding 4 — inject ⊆ readScope Validation

**What `inject` (template `inject` / `node.json.hooks.seed.from` / `io.reads`) does:** The loader at `packages/core/src/workflow/template/loader.ts:126–141` collects `op.reads` (the lowered `inject` fields) and folds them into `io.reads` (line 141: `reads: unique(opReads)`). These become the files staged INTO the sandbox by the runner (runner.ts:1013–1017):
```typescript
for (const rel of node.io.reads) {
  const data = await readHostFile(ctx, rel);
  if (data) await sandbox.writeFile(rel, data);
}
```

**Is inject ⊆ readScope validated?** No. The template static checks in `packages/core/src/workflow/template/checks.ts` check:
- `(1)` JSON schema validity
- `(2)` dangling deps
- `(3)` cycles
- `(4)` parallel owns overlap
- `(5)` dangling state channels
- `(6)` dangling producer/consumer (`checkProducers`) — checks that an `inject` read produced somewhere in the graph has an upstream producer, but does **NOT** check that it is within `readScope`
- `(7)` dangling refs (file existence)
- `(8)` MCP literal-secret guard

No check anywhere validates that `inject` paths (or any element of `io.reads`) are contained within `contract.readScope`. This gap exists in `checks.ts` (lines 1–334) — **NOT FOUND**: any `inject ⊆ readScope` subset check.

**Would injected-but-out-of-scope files silently EPERM when sandboxing is on?** Yes. In `seatbelt` mode: the runner would stage the file into the sandbox via `sandbox.writeFile` (this writes to the sandbox's tmpdir root, which IS in the allowed scope), but if the node subsequently tried to READ the file from the HOST via a bash/tool call to its host path, the Seatbelt profile would EPERM the open. However, the runner already staged the file's content into the sandbox at the relative path, so the agent can read it at the relative sandbox path — no EPERM for the staged content. The EPERM would only occur if the agent tried to read the HOST-SIDE absolute path outside the declared readScope. This is a subtlety: inject works correctly AS LONG AS the agent reads the staged copy, not the host original. There is no check that ensures the injected paths are within readScope before sandboxing is applied — the two systems are entirely parallel with no coordination.

---

### Finding 5 — Secure-by-Default vs. Opt-In

**Isolation posture today: OPT-IN (and SDK-only opt-in at that).**

The CLI `--sandbox` flag (`run.ts:90, 132, 143`) accepts exactly two values:
- `inmemory` — the DEFAULT; the in-memory reference provider; intended for offline/test use; no real `pi` is spawned
- `local` — the real in-place exec provider; bare spawn; **no OS enforcement**

`seatbelt` (the only OS-enforcing provider) is not in `SandboxChoice` and is not exposed by the CLI. To use it, a library consumer must import `SeatbeltSandboxProvider` from `@piflow/core` and pass it as `provider` to `runWorkflow`/`runFromConfig`.

**Is there a "danger" escape hatch?** No. The inversion is complete: the dangerous mode (bare spawn with full host-FS read access) is the **silent default** for every real run. The safe mode (seatbelt kernel enforcement) is not reachable from the CLI at all. There is no `--danger-full-access` flag, no `PIFLOW_SANDBOX=none` env var, and no naming convention that signals a safety boundary is being lowered. The ecosystem standard (Codex: `danger-full-access` as an explicit opt-out; Claude Code SRT: deny-write default) is completely inverted in piflow.

**The comment in `index.ts:4`** confirms this is known:
> `It does NOT enforce read/write scope (that is the Seatbelt provider, ROADMAP M1) — it is the local, no-isolation baseline the runner and tests build on.`

The Seatbelt provider was implemented (M1 is done), but was never wired into the CLI default path.

---

### Finding 6 — The Minimal Default-On Diff

**Goal:** Make readScope OS-enforcement the default for `--sandbox local` (and `worktree`) on macOS, reusing the existing Seatbelt profile builder. Keep backward compatibility by allowing a `danger-full-access` escape hatch.

#### Option A — Preferred: CLI selects SeatbeltSandboxProvider as default on darwin for `--sandbox local`

**Seam:** `packages/cli/src/run.ts:333`

Current code:
```typescript
const provider = parsed.sandbox === 'local' ? makeLocalProvider() : undefined;
```

Proposed change:
```typescript
const provider = parsed.sandbox === 'local'
  ? makeLocalProvider()
  : parsed.sandbox === 'danger-full-access'
    ? new LocalSandboxProvider()   // explicit escape hatch
    : undefined;
```

And `makeLocalProvider` (currently `() => new LocalSandboxProvider()`, line 238) would change to select by platform:
```typescript
makeLocalProvider: () => process.platform === 'darwin'
  ? new SeatbeltSandboxProvider()
  : new LocalSandboxProvider(),   // linux: no bwrap yet — see gap note below
```

**`SandboxChoice` type** (`run.ts:90`) needs to add `'danger-full-access'` and `'seatbelt'`:
```typescript
export type SandboxChoice = 'inmemory' | 'local' | 'seatbelt' | 'danger-full-access';
```

**Flag parse** (`run.ts:143`) already handles arbitrary strings via the cast; `SandboxChoice` is widened.

**Imports** (`run.ts:16–47`) need `SeatbeltSandboxProvider` added from `@piflow/core`.

**The `--sandbox local` help text** in `cli.ts:41` needs updating to reflect that `local` = seatbelt on macOS.

#### Option B — Simpler: SeatbeltSandbox wraps LocalSandbox exec by default

**Seam:** `packages/core/src/sandbox/local.ts:85` (`LocalSandbox.exec`)

Replace the bare `spawn` with a conditional: if darwin and not `PIFLOW_SANDBOX=danger-full-access`, delegate to `buildSeatbeltProfile` + `sandbox-exec`. This keeps the provider-kind `'local'` and avoids changing the CLI.

**This is messier** because `LocalSandbox.exec` doesn't have `readScope` — it was discarded at `create`. The `create` method would need to store `opts.readScope` and thread it to `exec`. This is 3–4 line changes at `local.ts:58–63` (store readScope) and `local.ts:85` (wrap exec), but couples the local and seatbelt implementations.

**Recommended seam: Option A** (the runner/CLI selects the right provider by platform; providers stay single-purpose).

#### Toolchain allow-list gotcha

When `SeatbeltSandboxProvider` wraps `--sandbox local` runs, the profile auto-grants (`seatbelt.ts:145–151`):
- `workdir` + `node_modules` of workdir
- `process.cwd()/node_modules` (the host process cwd)
- The declared `readScope` entries

**BUT** the `buildSeatbeltProfile` auto-grants are written for the SEATBELT provider's OWN tmpdir root (`InMemorySandbox`-style). In the LOCAL provider context, the workdir IS the real repo tree (not a throwaway tmpdir), and the `pi` CLI binary may be installed via nvm at `~/.nvm/versions/node/vX.Y.Z/bin/pi`. The profile template (`read-scope.sb:85`) grants `(subpath "@HOME@/.nvm")`, which covers nvm-installed binaries — but only if the path is under `~/.nvm`. An `fnm`-installed node (`~/.local/share/fnm/`) or a `mise`-installed node (`~/.local/share/mise/`) would be blocked with EPERM when the agent process tries to exec sub-tools.

**Specific missing paths for `local` mode on macOS (not covered by the template):**
- `~/.piflow/` — piflow user config (granted by a local add; the template has `@HOME@/.pi` but not `.piflow`)
- `${NVM_DIR}` when set to a non-default location — the template hardcodes `@HOME@/.nvm`
- `~/.local/share/fnm/` or `~/.local/share/mise/` — alt node version manager paths
- The repo root itself (the actual in-place workdir) — `buildSeatbeltProfile` grants `workdir`, but for `LocalSandboxProvider` the workdir IS the user's project root, and some tools read parent dirs (e.g., git reads `.git/` which may be a parent); granting `path.dirname(workdir)` or the git root may be needed
- `/proc` (needed on macOS for some node internals, though less critical than Linux)

**The `$TMPDIR` expansion problem** (`read-scope.sb:53`): The template uses `(subpath "@TMPDIR@")` substituted with `os.tmpdir()` (`seatbelt.ts:157`). On macOS, `os.tmpdir()` returns `/var/folders/...` which is a symlink to `/private/var/folders/...`. The profile grants `(subpath "/private/var")` globally (line 49 of `read-scope.sb`), so this is already covered. However, this broad `/private/var` grant may be wider than ideal — it covers ALL of `/private/var`, not just the session tmpdir.

#### Linux gap

`seatbelt.ts:98`: `const IS_DARWIN = process.platform === 'darwin'`. On non-darwin the provider falls through to bare `spawn` (lines 231–235) with a one-time `console.warn`. There is **no bubblewrap + Landlock implementation for Linux** in piflow. The research baseline (`docs/research/2026-06-26-sandbox-readscope-isolation-best-practice.md` §G2) specifies the correct approach: `bwrap --ro-bind / / --bind <workdir> <workdir> --unshare-net --proc /proc` + Landlock for fine-grained read restriction. A `BubbleWrapSandbox` provider would need to be authored following Codex's `codex-linux-sandbox` pattern. Until then, `--sandbox local` on Linux remains unsandboxed regardless of this fix.

---

## MINIMAL DEFAULT-ON DIFF — Summary

**Where the change lands:**

1. **`packages/cli/src/run.ts:90`** — Widen `SandboxChoice` to include `'seatbelt'` and `'danger-full-access'`.
2. **`packages/cli/src/run.ts:238`** — Change `makeLocalProvider` default to return `SeatbeltSandboxProvider` on darwin, `LocalSandboxProvider` on Linux.
3. **`packages/cli/src/run.ts:333`** — Handle `danger-full-access` as an explicit escape hatch that constructs `LocalSandboxProvider` (bareuncontained).
4. **`packages/cli/src/run.ts` imports** — Add `SeatbeltSandboxProvider` to the import from `@piflow/core`.
5. **`packages/cli/src/cli.ts:41`** — Update `--sandbox` help text to document `local` = seatbelt on macOS, `danger-full-access` = no sandbox.

**Toolchain allowlist fix required simultaneously** (otherwise `pi` itself EPERMs at startup):
- Add `~/.piflow/` to the seatbelt profile template (`packages/core/src/sandbox/read-scope.sb`) alongside `~/.pi/`.
- Resolve `$NVM_DIR` / `$FNM_DIR` / `$MISE_DATA_DIR` at sandbox construction time and pass them as additional auto-grants in `buildSeatbeltProfile` (`packages/core/src/sandbox/seatbelt.ts:145–151`).

**What is still missing after this fix:**
- Linux kernel enforcement (no bwrap/Landlock provider exists — `seatbelt.ts:100–108` already warns).
- Write-scope OS enforcement (`owns` is prompt-convention only; Seatbelt profile uses `(allow default)` which allows writes everywhere; restricting writes would require adding `(deny file-write*)` + allow-listing the output dir and tmpdir).
- Network restriction (seatbelt profile `(allow default)` leaves network open; adding `(deny network*)` except localhost proxy would match Codex's posture).

---

## SELF-CHECK AGAINST BAR ITEMS

| Bar item | Status | Evidence |
|---|---|---|
| 1. Provider matrix covers ALL 6 kinds with a file:line proving staged vs kernel-enforced vs ignored (the exec path is the proof) | **PASS** | `local.ts:85` (bare spawn); `index.ts:49` (bare spawn); `seatbelt.ts:221–229` (sandbox-exec wrap); `worktree.ts:120` (bare spawn); `daytona.ts:259–266` (executeCommand/execSession, no bwrap); `types.ts:210` + `index.ts:118–125` (e2b = NotImplemented) |
| 2. Q2 pins exactly which provider `--sandbox local` constructs and states unambiguously whether seatbelt is CLI-reachable | **PASS** | `run.ts:90` (SandboxChoice type), `run.ts:132` (default 'inmemory'), `run.ts:238` (makeLocalProvider = LocalSandboxProvider), `run.ts:333` (provider = makeLocalProvider() when 'local'); seatbelt NOT in SandboxChoice, not imported in run.ts |
| 3. Q3 gives yes/no on bash-breach in local/worktree mode with the line that does (or fails to do) the enforcing | **PASS** | `local.ts:85–95` (bare spawn, YES breach); `worktree.ts:120–130` (bare spawn, YES breach); the enforcing line for seatbelt is `seatbelt.ts:221–229` |
| 4. Q6 names a SPECIFIC seam with file:line anchors and the toolchain allow-list gotcha | **PASS** | `run.ts:90`, `run.ts:238`, `run.ts:333`; gotcha: nvm/fnm/mise paths not in profile, `~/.piflow/` missing, Linux has no bwrap |
| 5. Every claim has a file:line anchor; "NOT FOUND" used when no evidence | **PASS** | inject ⊆ readScope: NOT FOUND in `checks.ts:1–334`; e2b: `types.ts:210`, `index.ts:118–125`; write enforcement: NOT FOUND in any provider |

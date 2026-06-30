---
type: subsystem
key: sandbox
title: Sandbox (per-node OS filesystem jail — declare → plan → kernel-enforce)
description: How a node's declared readScope/owns become a kernel-enforced filesystem jail — a shared scope policy rendered as a macOS seatbelt SBPL profile or Linux bwrap bind-mount argv, wrapping the in-place pi exec so reads/writes outside the lane EPERM; danger-full-access is the bypass.
resource: packages/core/src/sandbox/scope.ts
aliases: [sandbox, seatbelt, bwrap, bubblewrap, readScope, owns, jail, danger-full-access, sandbox-exec, read-scope.sb, computeScopeRoots, worktree]
seeds: [packages/core/src/sandbox/scope.ts, packages/core/src/sandbox/jail.ts, packages/core/src/sandbox/seatbelt.ts, packages/core/src/sandbox/bwrap.ts, packages/core/src/sandbox/local.ts, packages/core/src/sandbox/read-scope.sb, packages/core/src/workflow/template/schema/node.schema.ts, packages/cli/src/run.ts]
symbols: [computeScopeRoots, localJailPlan, seatbeltExecPlan, buildSeatbeltProfile, bwrapExecPlan, buildBwrapArgs, LocalSandbox, LocalSandboxProvider]
tags: [sandbox, security, runner, cli, core]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
A node declares `readScope` (dirs it may read) and `owns` (dirs it may write) in `node.json`. The
template `loader` lowers these to `node.sandbox.{read,write}`; `node-lifecycle` passes them as
`CreateOpts.{readScope,writeScope}` into the sandbox provider. The DEFAULT provider is `LocalSandbox`
(in-place — runs in the real working tree, never `mkdtemp`s). On every `exec` it calls `localJailPlan`,
the OS dispatcher, which routes darwin→`seatbeltExecPlan`, linux→`bwrapExecPlan`. Both backends consume
the ONE shared policy `computeScopeRoots` (workdir + node_modules + node toolchain + readScope as read
roots; workdir + owns as write roots, realpath-expanded). Seatbelt renders these as SBPL `(subpath …)`
allow rules in a per-exec `.sb` (from the `read-scope.sb` template) and runs `sandbox-exec -f <profile>
sh -c <cmd>`; bwrap renders them as `--ro-bind`/`--bind` argv in a fresh mount namespace. Either way a
read/write outside the lane EPERMs, kernel-enforced and inherited by every child. Network + exec stay
open (the `pi` agent reaches its gateway). `LocalSandboxProvider({enforceReadScope:false})` — selected
by `--sandbox danger-full-access` — is the loud bypass. `WorktreeSandboxProvider` adds per-run git WRITE
isolation, composable with seatbelt.

# Anchors
SCOPE (declare)
- `packages/core/src/workflow/template/schema/node.schema.ts:136` — `owns` field — write-authority globs (→ writeScope)
- `packages/core/src/workflow/template/schema/node.schema.ts:141` — `readScope` field — exposed read dirs + the OS allow-list
- `packages/core/src/workflow/template/loader.ts:146` — lowers `readScope`/`owns` → `node.sandbox.{read,write}`
- `packages/core/src/runner/node-lifecycle.ts:201` — passes them as `CreateOpts.{readScope,writeScope}` into `scope.create`
PLAN (shared policy + dispatch)
- `packages/core/src/sandbox/scope.ts:71` — `computeScopeRoots()` — the SINGLE source of read/write roots both backends render
- `packages/core/src/sandbox/jail.ts:50` — `localJailPlan()` — OS dispatcher: darwin→seatbelt, linux→bwrap, else warn+bare
- `packages/core/src/sandbox/local.ts:125` — `LocalSandbox.exec` wraps the command in the jail plan (default); `null` ⇒ bare
ENFORCE (macOS)
- `packages/core/src/sandbox/seatbelt.ts:203` — `seatbeltExecPlan()` — writes a per-exec `.sb`, returns `sandbox-exec -f <p> sh -c <cmd>`
- `packages/core/src/sandbox/seatbelt.ts:154` — `buildSeatbeltProfile()` — renders read/write roots as SBPL `(subpath …)` allows
- `packages/core/src/sandbox/read-scope.sb:46` — `(deny file-read*)` … `@SCOPE_ALLOWS@` — the deny-all-then-reallow template
ENFORCE (linux)
- `packages/core/src/sandbox/bwrap.ts:248` — `bwrapExecPlan()` — null off-linux or no-bwrap (warns once), else bwrap argv
- `packages/core/src/sandbox/bwrap.ts:188` — `buildBwrapArgs()` — renders roots as `--ro-bind`/`--bind` mount-namespace argv
BYPASS
- `packages/cli/src/run.ts:504` — `--sandbox danger-full-access` → `makeLocalProvider({dangerous:true})` (enforceReadScope:false)

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: `cli/src/run.ts:502` prints "Linux bwrap backend unwired … UNSANDBOXED" but `jail.ts:57` DOES route linux→`bwrapExecPlan` and `local.ts` calls it — the backend IS wired; only kernel EPERM is unverified-in-CI (bwrap absent on the macOS dev host). · `DaytonaSandboxProvider` (packages/daytona/src/daytona.ts) accepts CreateOpts but does NOT enforce readScope/owns in the cloud VM (no jail) — scope enforcement is local/seatbelt/bwrap only.

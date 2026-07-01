---
type: subsystem
key: sandbox
title: Sandbox (per-node OS filesystem jail — declare → plan → kernel-enforce)
description: How a node's declared readScope/owns become a kernel-enforced filesystem jail — a shared scope policy rendered as a macOS seatbelt SBPL profile or Linux bwrap bind-mount argv, wrapping the in-place pi exec so reads/writes outside the lane EPERM; danger-full-access is the bypass.
resource: packages/core/src/sandbox/scope.ts
aliases: [sandbox, seatbelt, bwrap, bubblewrap, readScope, owns, jail, danger-full-access, sandbox-exec, read-scope.sb, computeScopeRoots, worktree, fullAccess, enforceReadScope, per-node full access]
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
- `packages/core/src/sandbox/jail.ts:54` — `localJailPlan()` — OS dispatcher: darwin→seatbelt, linux→bwrap, else warn+bare
- `packages/core/src/sandbox/local.ts:125` — `LocalSandbox.exec` wraps the command in the jail plan (default); `null` ⇒ bare
ENFORCE (macOS)
- `packages/core/src/sandbox/seatbelt.ts:217` — `seatbeltExecPlan()` — writes a per-exec `.sb`, returns `sandbox-exec -f <p> sh -c <cmd>`
- `packages/core/src/sandbox/seatbelt.ts:154` — `buildSeatbeltProfile()` — renders read/write roots as SBPL `(subpath …)` allows
- `packages/core/src/sandbox/read-scope.sb:46` — `(deny file-read*)` … `@SCOPE_ALLOWS@` — the deny-all-then-reallow template
ENFORCE (linux)
- `packages/core/src/sandbox/bwrap.ts:293` — `bwrapExecPlan()` — null off-linux or no-bwrap (warns once), else bwrap argv
- `packages/core/src/sandbox/bwrap.ts:216` — `buildBwrapArgs()` — renders roots as `--ro-bind`/`--bind` mount-namespace argv
BYPASS
- `packages/cli/src/run.ts:504` — `--sandbox danger-full-access` → `makeLocalProvider({dangerous:true})` (enforceReadScope:false) — RUN-level bypass
- `packages/core/src/workflow/template/schema/node.schema.ts:155` — `fullAccess` field — PER-NODE jail-off (`node.sandbox.fullAccess`): this ONE node runs outside the fs jail even under `--sandbox local`
- `packages/core/src/sandbox/local.ts:72` — `enforceReadScope` — LocalSandbox constructor param; `false` (per-node fullAccess or `danger-full-access`) short-circuits the jail plan (bare exec)

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: `cli/src/run.ts:502` prints "Linux bwrap backend unwired … UNSANDBOXED" but `jail.ts:57` DOES route linux→`bwrapExecPlan` and `local.ts` calls it — the backend IS wired; only kernel EPERM is unverified-in-CI (bwrap absent on the macOS dev host). · `DaytonaSandboxProvider` (packages/daytona/src/daytona.ts) accepts CreateOpts but does NOT enforce readScope/owns in the cloud VM (no jail) — scope enforcement is local/seatbelt/bwrap only.

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/sandbox/scope.ts` | ✓ |
| `packages/core/src/sandbox/jail.ts` | ✓ |
| `packages/core/src/sandbox/seatbelt.ts` | ✓ |
| `packages/core/src/sandbox/bwrap.ts` | ✓ |
| `packages/core/src/sandbox/local.ts` | ✓ |
| `packages/core/src/sandbox/read-scope.sb` | ✓ |
| `packages/core/src/workflow/template/schema/node.schema.ts` | ✓ |
| `packages/cli/src/run.ts` | ✓ |

### Evolution arc

- `efe18e6` 2026-06-21 — feat(core): Seatbelt read-scope SandboxProvider (macOS) — M1 isolation
- `1487e0b` 2026-06-21 — docs: replace "cheap" framing with non-Claude/efficient across repo
- `b1c65e4` 2026-06-21 — feat(core): WorktreeSandboxProvider — per-run git WRITE isolation on the RunScope seam
- `0321415` 2026-06-23 — fix(core): harden run capture against pi's cumulative-snapshot bloat
- `24defb1` 2026-06-23 — feat(core): LocalSandboxProvider — in-place 'local' sandbox kind (U2)
- `0794e2c` 2026-06-23 — feat(core): template-format JSON schema + min fixture + validation test (T1)
- `334208d` 2026-06-23 — feat(cli): piflow run [--dry-run] and wire run+extract dispatch
- `e640d1a` 2026-06-23 — feat(template): recover discriminated DRIVER-MERGE ops from game-omni-v1.6 (S4)
- `1a3fa37` 2026-06-23 — feat(cli): real run — route LIVE through core runFromTemplate, thread args/workspace/sandbox
- `8aad7fc` 2026-06-23 — feat(core): wire seedContracts + genre-projection POST-ops into the run loop (P2/P3)
- `6d9b4b1` 2026-06-23 — refactor(core): complete the SDK de-game-ification — T1/2 core (recovered) + T3 relocation
- `9c50439` 2026-06-24 — fix(cli): dry-run renders --thinking faithfully (mirror the LIVE command)
- `df5a1fc` 2026-06-24 — fix(cli): piflow run surfaces a blocked/failed run — no more silent exit-0
- `638d72e` 2026-06-24 — feat(cli): --profile <name> flag threaded through run (dry-run + live)
- `de31eac` 2026-06-24 — fix: capture runs only from the canonical .piflow/<wf>/runs home
- `9ec0710` 2026-06-24 — feat(core): docker-style <adjective>-<pie> auto-naming for runs
- `b798599` 2026-06-25 — feat(cli): add --max-concurrent flag threading the G2 cap to runFromTemplate
- `3f49ee3` 2026-06-25 — feat(core): wire content-hash journal resume into the runner (G4)
- `067b365` 2026-06-25 — feat(core): add the G5 human-checkpoint NODE KIND (schema → spec) + awaiting-input
- `0bb0f69` 2026-06-25 — feat(core): expose per-node timeoutMs/retries at the template level
- `5243633` 2026-06-25 — feat(core): carry per-node model/provider/tier through the template (G1)
- `6acf030` 2026-06-25 — feat(cli): dry-run shows each node's effective model/provider (G1)
- `794d68e` 2026-06-25 — feat(core): carry the per-node `fusion` block through the template (T2.1)
- `5604721` 2026-06-25 — feat(core): carry agentType label through template → observe (G6)
- `83fc3c8` 2026-06-25 — fix(cli): a canonical run home is never relocated by --out
- `6aae3e6` 2026-06-25 — feat: wire expandFusion into the run path + dry-run; runnable example (T2.4/T2.6)
- `2b1f8d1` 2026-06-25 — feat(core): G9 — subworkflow sub-DAG inlining (expandSubworkflow)
- `8e66a3a` 2026-06-25 — feat(cli): G7 — --detach (unattended) threads checkpointReply:'default'
- `32c3b42` 2026-06-25 — feat(core): assembleRunTools — seed the tool catalog into the canonical run path (M1)
- `331fef6` 2026-06-25 — fix(cli): G9 — dry-run expands subworkflow nodes (was a lying preview)
- `3b38db0` 2026-06-25 — feat(core): M5 lower deprecated grammars into the unified op[] at the loader
- `0564114` 2026-06-26 — merge: integrate main (G3/G6/G7/G9) into the node-action M0–M7 lineage
- `e78f94c` 2026-06-26 — refactor(cli): rename global bin piflow → piflowctl
- `1700eb3` 2026-06-26 — feat(cli): dry-run materializes a VIEWABLE plan (run.json + workflow.json)
- `41159ef` 2026-06-26 — feat(sandbox): default-on read-scope jail for --sandbox local
- `7825569` 2026-06-26 — feat(sandbox): bound writes too — symmetric write-scope jail for --sandbox local
- `779f327` 2026-06-26 — feat(sandbox): Linux bwrap backend + OS-dispatched local jail (kernel path PENDING Linux verify)
- `aac514e` 2026-06-26 — feat(sandbox): wire --sandbox daytona + cloud provider-credential forwarding (M1)
- `826eca1` 2026-06-26 — feat(sandbox): M1b — stage custom-gateway models.json into the cloud VM
- `ed46d99` 2026-06-26 — feat(sandbox): M1c — boot daytona from a promoted snapshot (default) + ripgrep + promote script
- `be2f36b` 2026-06-26 — feat(e2b): @piflow/e2b installable sandbox extension + CLI choose-to-install wiring
- `7f1b283` 2026-06-27 — feat(runner): programmatic (no-pi) node kind
- `08c153a` 2026-06-27 — refactor(daytona): extract the Daytona cloud backend into @piflow/daytona
- `80eca4b` 2026-06-27 — Merge main into feat/programmatic-node — consolidate sandbox extensions
- `c7cb370` 2026-06-27 — fix(sandbox): banner + docs state programmatic nodes run unsandboxed on host
- `caf6e4e` 2026-06-28 — feat(core): materialize judge gate into a real DAG node at load time
- `51992b0` 2026-06-28 — feat: per-node stop — persist each node's pi pid, signal its group
- `a52e6c9` 2026-06-29 — feat(executor): template + CLI authoring can select the claude-code executor
- `4415ae9` 2026-06-29 — feat(core): per-node fullAccess flag — open the fs jail for one node
- `a935280` 2026-06-29 — merge: claude-code 2nd node executor + interactive piflowctl init wizard
- `e13f1ee` 2026-06-30 — fix(core): treat bwrap as available only if it can build a namespace
- `75a3336` 2026-06-30 — fix(core): bwrap capability probe + private-/tmp ordering (Findings A+B)
- `c81c11f` 2026-06-30 — feat(core)!: fail-closed local sandbox — refuse rather than run unsandboxed
- `132b524` 2026-06-30 — feat(core): optional `note` affordance on op[] and node top-level (A3)
- `383dabb` 2026-06-30 — fix(core): normalize `owns` glob write-roots to recursive create-grants (E11a)
- `25c4226` 2026-06-30 — feat(core): execCwd/execReads exec-scope for out-of-tree builds (E10)
- `d68b47f` 2026-06-30 — fix(core): SeatbeltSandbox carries execCwd/execReads (parity with LocalSandbox, E10)

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[capability-catalog-feed]]
- [[claude-code-executor]]
- [[cloud-sandbox-portability]]
- [[codebase-memory-mcp-analysis]]
- [[codegraph-best-practices]]
- [[competitive-gaps-pdw]]
- [[config-is-truth-gui-is-projection]]
- [[daytona-cloud-path]]
- [[expert-representations]]
- [[g11-g13-node-action-protocol]]
- [[game-omni-reference-product]]
- [[gui-live-viewer-scope]]
- [[gui-nodehud-redesign]]
- [[mastra-competitive-analysis]]
- [[no-demo-html-wire-into-screen]]
- [[node-illustration-pipeline]]
- [[op-consumption-two-layer]]
- [[per-node-routing-fusion]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-init-scaffolder]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-product-positioning]]
- [[sandbox-readscope-default-on]]
- [[tui-dag-structure-source]]

### Code anchors / blast radius (codegraph)

- `bwrapExecPlan` (packages/core/src/sandbox/bwrap.ts:293) — 4 callers in `packages/core/src/sandbox/jail.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/sandbox-bwrap.test.ts`
- `BwrapExecPlan` (packages/core/src/sandbox/bwrap.ts:277) — 2 callers in `packages/core/src/index.ts`, `packages/core/src/sandbox/bwrap.ts`; ⚠ no covering tests found
- `localJailPlan` (packages/core/src/sandbox/jail.ts:54) — 4 callers in `packages/core/src/sandbox/local.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/sandbox-bwrap.test.ts`
- `seatbeltExecPlan` (packages/core/src/sandbox/seatbelt.ts:217) — 3 callers in `packages/core/src/sandbox/jail.ts`, `packages/core/src/sandbox/seatbelt.ts`; ⚠ no covering tests found
- `buildBwrapArgs` (packages/core/src/sandbox/bwrap.ts:216) — 5 callers in `deploy/e2b/bwrap-proof-driver.mjs`, `packages/core/src/sandbox/bwrap.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/sandbox-bwrap.test.ts`

<sub>derived 2026-07-01 · arc=57 commits · files=8 · lessons=25</sub>
<!-- okf:auto-end -->

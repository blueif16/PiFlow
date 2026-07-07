---
type: subsystem
key: context
title: Context (local⇄cloud switch — the two axes host + worker — and the sandbox merge)
description: How `piflowctl context` switches the named control-plane endpoint AND, via a two-axis {host, worker} model + a cloud→worker cascade, drives WHERE nodes run — a context's `worker` IS the sandbox, so `--sandbox` is now its LEGACY per-run override (flag > context-worker > default).
resource: packages/cli/src/context-store.ts
aliases: [context, contexts.json, context use, context host use, context worker use, HostKind, WorkerKind, resolveWorker, defaultWorkerFor, isCloudEntry, resolveRunSandbox, cascade, worker, sandbox merge, setup-on-miss, selfhost, cloudflared, WORKER_PRECEDENCE, configuredWorkers]
seeds: [packages/cli/src/context-store.ts, packages/cli/src/context.ts, packages/cli/src/run.ts]
symbols: [resolveWorker, defaultWorkerFor, isCloudEntry, isWorkerCompatible, configuredWorkers, resolveRunSandbox, runContextCli, resolveActive, useContext]
tags: [context, cli, cloud, sandbox, switch]
timestamp: 2026-07-01
---

# Why / how it works (the lifecycle, end to end)
A `context` is ONE switchable operating profile with TWO axes: WHERE the control plane runs (`host` +
its `baseUrl`/`token`) and WHERE the workers run (`worker` = each node's `pi`). The design pattern is
**one canonical noun (`context`) with two fields**, not three peer nouns — you live in `context use
<name>` and the fields are the escape hatch. The axes are correlated but not identical, which is WHY they
can't collapse to one provider list: a CLOUD control plane physically can't reach your laptop's local
sandbox, so the worker CASCADES off the host. The cascade is pure: `isCloudEntry` (baseUrl is
AUTHORITATIVE — `baseUrl === the local serve ⇒ local`, else remote; `host` is a display/provisioning label
that does NOT flip cloud-ness) → `isWorkerCompatible` (a cloud plane rejects the `local` worker) →
`defaultWorkerFor` (the top-PRECEDENCE cloud worker that is CONFIGURED, `e2b > daytona`; `local` for a
local host) → `resolveWorker` (an explicit compatible worker is kept, else PROMOTED). `isCloudEntry` is
the SAME predicate `resolveRemote` (run routing) and `isLocalEntry` (migrate) key on — ONE source of truth
for remote-ness, so the cascade can never disagree with where the run actually goes. `docker` is
DEFERRED from the cascade (its name is ambiguous — local container vs docker-hosted plane) though
`--sandbox docker` still works per-run. The CLI (`runContextCli`) makes `use` print the cascaded worker
+ any promotion + SETUP-ON-MISS guidance (a not-yet-provisioned host or an unconfigured cloud worker
prints the exact command instead of a bare error — notably `selfhost` = the FREE `piflowctl serve` +
Cloudflare quick-tunnel path); `host use`/`worker use` edit one axis (worker-use REJECTS an incompatible
local-under-cloud pick, vs the cascade's auto-promote). THE MERGE: because `WorkerKind ⊂ SandboxChoice`,
a context's worker IS the sandbox — `resolveRunSandbox` applies **flag > context-worker > default**: an
explicit `--sandbox` is the LEGACY per-run override; else the active context's worker drives it; a plain
local context keeps the historical `inmemory` default (back-compat). One setting, not two.

# Anchors
DECLARE (the two-axis schema + cascade constants)
- `packages/cli/src/context-store.ts:29` — `HostKind` — the control-plane pathway kinds (`local` + the `--host` set)
- `packages/cli/src/context-store.ts:37` — `WorkerKind` — where nodes run (`local|daytona|e2b`); a strict SUBSET of `SandboxChoice`
- `packages/cli/src/context-store.ts:62` — `ContextEntry` — the persisted context: `baseUrl`/`token` + optional `host` + `worker` (two axes, back-compat optional)
- `packages/cli/src/context-store.ts:40` — `CLOUD_WORKERS` / `:42` `WORKER_PRECEDENCE` — cascade order `e2b > daytona > local` (docker deferred); ORDER is the contract
CASCADE (pure rules — the load-bearing logic)
- `packages/cli/src/context-store.ts:195` — `isCloudEntry()` — baseUrl-authoritative: `!== LOCAL_BASE_URL` ⇒ remote; `host` is a label, ignored — the SHARED predicate resolveRemote/isLocalEntry route on
- `packages/cli/src/context-store.ts:211` — `isWorkerCompatible()` — a cloud plane can't drive the `local` worker; local drives any
- `packages/cli/src/context-store.ts:220` — `defaultWorkerFor()` — top-precedence CONFIGURED cloud worker (or top as a setup-on-miss signal)
- `packages/cli/src/context-store.ts:229` — `resolveWorker()` — explicit-compatible kept, else promoted; returns `{worker, promoted, cloud}`
- `packages/cli/src/context-store.ts:50` — `configuredWorkers()` — which cloud workers have creds (`E2B_API_KEY`/`DAYTONA_API_KEY`) — the injected `configured` set
SWITCH (the CLI — one word to live in + escape hatches)
- `packages/cli/src/context.ts:115` — `runContextCli()` — the verb dispatch (use | host use | worker use | ls | add | rm | current | migrate)
- `packages/cli/src/context.ts:139` — `case 'use'` — switch the bundle; prints the cascaded worker + promotion + setup-on-miss
- `packages/cli/src/context.ts:162` — `case 'host'` — escape hatch: set just the control plane; drops a now-incompatible stored worker
- `packages/cli/src/context.ts:183` — `case 'worker'` — escape hatch: set just the worker; REJECTS an incompatible local-under-cloud pick
- `packages/cli/src/context.ts:56` — `hostSetupHint()` — setup-on-miss guidance; `selfhost` = the FREE serve + Cloudflare quick-tunnel (`*.trycloudflare.com`)
- `packages/cli/src/context.ts:73` — `workerSetupHint()` — cloud-worker cred setup guidance (`E2B_API_KEY` / `DAYTONA_API_KEY`)
TERMINAL (the merge — context worker IS the sandbox)
- `packages/cli/src/run.ts:893` — `resolveRunSandbox()` — the ONE resolver: `--sandbox` (legacy override) > context worker > `inmemory` default
- `packages/cli/src/run.ts:968` — `runRunCli` wiring — sets `parsed.sandbox = resolveRunSandbox(...)` before BOTH the local (`runTemplate`) and remote (`remoteStartBody`) paths
- `packages/cli/src/context-store.ts:134` — `resolveActive()` — the `--context` flag > `PIFLOW_CONTEXT` env > persisted `current` > `local` ladder (which context is active)

# Freshness (anti-drift)
anchors ✓ (opened + verified) · scope = the seeds above · pure cascade + the merge are unit-tested
(`packages/cli/test/context-store.test.ts`, `context.test.ts`, `run.test.ts` `resolveRunSandbox`) and
mutation-verified (compat flip, precedence flip, cascade-branch flip all go RED). re-derive when the
seeds change. ONE-PREDICATE NOTE: the run-routing gate (`remote.ts:resolveRemote`) and
`migrate.ts:isLocalEntry` now DELEGATE to `isCloudEntry`, so there is a SINGLE remote-ness predicate — a
divergence here previously routed a cloud-worker cascade onto a run that then executed on the local path.
DRIFT NOTE: `docker` is intentionally OUT of `WORKER_PRECEDENCE`/`WorkerKind` (ambiguous
local-vs-cloud) though `--sandbox docker` remains a valid per-run override. The `local` worker's actual
OS jail is owned by [[sandbox]]; the `e2b`/`daytona` cloud workers a cascade selects are owned by
[[cloud-backends]]; the `--host` provisioning pathways are [[cloud-backends]] + `packages/cli/src/hosts/`.
BRANCH CAVEAT: this slice was authored on `feat/context-host-worker`; the repo `codegraph` index lives at
the PRIMARY worktree (main) and lags these symbols until merge — validate with `OKF_NO_CODEGRAPH=1 node
_generate.mjs --check context` (deterministic line-check against the working tree) until then.

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/cli/src/context-store.ts` | ✓ |
| `packages/cli/src/context.ts` | ✓ |
| `packages/cli/src/run.ts` | ✓ |

### Evolution arc

- `334208d` 2026-06-23 — feat(cli): piflow run [--dry-run] and wire run+extract dispatch
- `1a3fa37` 2026-06-23 — feat(cli): real run — route LIVE through core runFromTemplate, thread args/workspace/sandbox
- `9c50439` 2026-06-24 — fix(cli): dry-run renders --thinking faithfully (mirror the LIVE command)
- `df5a1fc` 2026-06-24 — fix(cli): piflow run surfaces a blocked/failed run — no more silent exit-0
- `638d72e` 2026-06-24 — feat(cli): --profile <name> flag threaded through run (dry-run + live)
- `de31eac` 2026-06-24 — fix: capture runs only from the canonical .piflow/<wf>/runs home
- `9ec0710` 2026-06-24 — feat(core): docker-style <adjective>-<pie> auto-naming for runs
- `b798599` 2026-06-25 — feat(cli): add --max-concurrent flag threading the G2 cap to runFromTemplate
- `3f49ee3` 2026-06-25 — feat(core): wire content-hash journal resume into the runner (G4)
- `6acf030` 2026-06-25 — feat(cli): dry-run shows each node's effective model/provider (G1)
- `83fc3c8` 2026-06-25 — fix(cli): a canonical run home is never relocated by --out
- `6aae3e6` 2026-06-25 — feat: wire expandFusion into the run path + dry-run; runnable example (T2.4/T2.6)
- `8e66a3a` 2026-06-25 — feat(cli): G7 — --detach (unattended) threads checkpointReply:'default'
- `32c3b42` 2026-06-25 — feat(core): assembleRunTools — seed the tool catalog into the canonical run path (M1)
- `331fef6` 2026-06-25 — fix(cli): G9 — dry-run expands subworkflow nodes (was a lying preview)
- `0564114` 2026-06-26 — merge: integrate main (G3/G6/G7/G9) into the node-action M0–M7 lineage
- `e78f94c` 2026-06-26 — refactor(cli): rename global bin piflow → piflowctl
- `1700eb3` 2026-06-26 — feat(cli): dry-run materializes a VIEWABLE plan (run.json + workflow.json)
- `41159ef` 2026-06-26 — feat(sandbox): default-on read-scope jail for --sandbox local
- `aac514e` 2026-06-26 — feat(sandbox): wire --sandbox daytona + cloud provider-credential forwarding (M1)
- `826eca1` 2026-06-26 — feat(sandbox): M1b — stage custom-gateway models.json into the cloud VM
- `ed46d99` 2026-06-26 — feat(sandbox): M1c — boot daytona from a promoted snapshot (default) + ripgrep + promote script
- `be2f36b` 2026-06-26 — feat(e2b): @piflow/e2b installable sandbox extension + CLI choose-to-install wiring
- `08c153a` 2026-06-27 — refactor(daytona): extract the Daytona cloud backend into @piflow/daytona
- `c7cb370` 2026-06-27 — fix(sandbox): banner + docs state programmatic nodes run unsandboxed on host
- `e82e2b3` 2026-07-01 — feat(core): run-start executor override (pick pi|claude-code per node/run without editing the template)
- `1c00da0` 2026-07-01 — feat(cli): piflowctl context — switch the CLI/GUI between local & cloud serve endpoints
- `e7a62b2` 2026-07-01 — feat(cli): P7 — the active context redirects observe/start to a remote serve
- `d529c10` 2026-07-01 — feat(cli): piflowctl context migrate — one-click upload/download (P6)
- `62a9c03` 2026-07-01 — feat(docker): local Docker container sandbox backend (--sandbox docker)
- `368ea00` 2026-07-01 — feat(docker): zero-setup auto-build + live-verified end to end
- `ebcf494` 2026-07-01 — feat(context): host/worker two-axis schema + pure cascade resolver
- `2692485` 2026-07-01 — feat(context): host/worker subverbs + cascade + setup-on-miss guidance
- `6c73eec` 2026-07-01 — feat(run): merge --sandbox into context worker (one setting; --sandbox = legacy override)
- `c358ceb` 2026-07-01 — fix(context): baseUrl is the ONE authoritative predicate for remote-ness
- `7a3ee69` 2026-07-02 — fix(cli): fail loud on --sandbox e2b without E2B_TEMPLATE (no silent exit-127)
- `0a00c73` 2026-07-02 — feat(P4): driverFits (2 axes) + schema --json agent + drivers catalog on /__piflow/agents.json (GREEN)
- `cb65b8d` 2026-07-02 — Merge feat/agent-driver-registry: AgentDriver registry (Thrust 3) — open DriverTable, pi/claude-code/fork drivers, driverFits, Claude stream-json on SSE, cost-spike + loopScore metrics
- `9db5099` 2026-07-02 — fix(cli,core,server): anchor a run at its product, not process.cwd()
- `80a727b` 2026-07-02 — feat(cli): cloud push + auto-push-on-run + migrate push-before-adopt
- `abdb3ab` 2026-07-02 — refactor(core): kill the hardcoded 'cp' provider default — single system default = pi settings.json
- `4221b3a` 2026-07-02 — fix(cli): cloud sandbox stages the EFFECTIVE (system-default) provider gateway, not the raw flag
- `e400373` 2026-07-02 — fix(cli): honest sandbox-staging signal — a literal-key gateway is NOT "unresolved"
- `ea146ff` 2026-07-02 — Merge feat/full-run-e2e: model default = the single system fixture (pi settings.json) + template-push + cloud plane
- `20e9eae` 2026-07-02 — feat(core,cli): node --rerun — targeted rerun-set, not a noResume stage window
- `d6842bc` 2026-07-05 — Merge feat/context-composition-telemetry — run-layout under .piflow, per-node thinking, node --rerun, context-composition telemetry, Leg-C method-library sync
- `7a072d0` 2026-07-05 — fix(cli): dry-run plan discovers script tools — the preview must not lie
- `22a4ccc` 2026-07-05 — fix(cli): dry-run preview renders the "optional, not present" note
- `56c1d8e` 2026-07-06 — feat(optimize): M1 — run identity: date-seq names, lineage fields, child runs
- `fdc76dd` 2026-07-06 — merge main — pick up tools.defs schema + 40 upstream commits (worktree base predated the tool-wiring overhaul)

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[agentic-design-library]]
- [[claude-code-executor]]
- [[cloud-control-plane-local-cloud-switch]]
- [[cloud-sandbox-portability]]
- [[competitive-gaps-pdw]]
- [[compose-gate-drag-audit]]
- [[context-composition-telemetry]]
- [[delegate-inspection-to-subagents]]
- [[design-at-init-architecture]]
- [[eval-bulk-agents-use-cheaper-model]]
- [[expert-representations]]
- [[g6-agenttype-presets]]
- [[gui-nodehud-redesign]]
- [[guidance-node-sonnet5-routing]]
- [[hooks-give-info-never-autofix]]
- [[local-docker-sandbox-mode]]
- [[mastra-competitive-analysis]]
- [[memory-legs-coordination]]
- [[merge-workspace-token-bug]]
- [[model-provider-single-default-fixture]]
- [[no-demo-html-wire-into-screen]]
- [[observe-single-data-path]]
- [[optimize-substrate-program]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-context-cloud-run-footgun]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[playbook-skills-depth-over-budget]]
- [[railway-deploy-from-main-not-worktree]]
- [[roadmap-bookkeeping-linear]]
- [[sandbox-readscope-default-on]]
- [[telemetry-legibility-tracks]]
- [[use-understanding-system-first]]

### Code anchors / blast radius (codegraph)

- `resolveWorker` (packages/cli/src/context-store.ts:230) — 6 callers in `packages/cli/src/context.ts`, `packages/cli/src/run.ts`; tests: `packages/cli/test/context-store.test.ts`
- `configuredWorkers` (packages/cli/src/context-store.ts:50) — 5 callers in `packages/cli/src/context.ts`, `packages/cli/src/run.ts`; ⚠ no covering tests found
- `defaultWorkerFor` (packages/cli/src/context-store.ts:221) — 1 caller; tests: `packages/cli/test/context-store.test.ts`
- `resolveActive` (packages/cli/src/context-store.ts:134) — 10 callers in `packages/cli/src/context.ts`, `packages/cli/src/remote.ts`, `packages/cli/src/migrate.ts`, `packages/cli/src/run.ts`; tests: `packages/cli/test/context-store.test.ts`
- `isCloudEntry` (packages/cli/src/context-store.ts:195) — 11 callers in `packages/cli/src/context-store.ts`, `packages/cli/src/context.ts`, `packages/cli/src/remote.ts`, `packages/cli/src/migrate.ts` +1 more; tests: `packages/cli/test/context-store.test.ts`

<sub>derived 2026-07-07 · arc=50 commits · files=3 · lessons=34</sub>
<!-- okf:auto-end -->

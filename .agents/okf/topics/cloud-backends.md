---
type: subsystem
key: cloud-backends
title: Cloud sandbox backends (Daytona & E2B — select → boot → pi-in-VM → cloud creds)
description: How `--sandbox daytona|e2b` lazy-loads a choose-to-install extension that boots ONE cloud VM per run (pi baked from @earendil-works/pi-coding-agent), runs each node in a per-node subtree, and crosses ONLY an allowlisted, SecretResolver-resolved gateway credential into the VM.
resource: packages/cli/src/run.ts
aliases: [daytona, e2b, langgraph, sandbox, cloud, SecretResolver, cloudCredEnvAdditions, pi-coding-agent, createDaytonaProvider, createE2bProvider, CLOUD_KINDS, stageHome, snapshot, template]
seeds: [packages/cli/src/run.ts, packages/daytona/src/daytona.ts, packages/daytona/src/daytona-sdk.ts, packages/e2b/src/e2b.ts, packages/e2b/src/e2b-sdk.ts, packages/core/src/runner/env-staging.ts, packages/core/src/types.ts, deploy/daytona/Dockerfile]
symbols: [createDaytonaProvider, createE2bProvider, DaytonaSandboxProvider, E2bSandboxProvider, SecretResolver, cloudCredEnvAdditions, CLOUD_KINDS, effectiveSandboxLocation]
tags: [cloud, sandbox, daytona, e2b, secrets, runner, extensions]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
SELECT: `parseRunArgs` reads `--sandbox <kind>` against `SANDBOX_CHOICES`; a `daytona`/`e2b`
branch DYNAMICALLY `import()`s the choose-to-install extension (`makeDaytonaProvider`/
`makeE2bProvider` — absent package ⇒ a clear `npm i` error), calling `createDaytonaProvider`/
`createE2bProvider`. INSTALL: each extension is dependency-free against a `DaytonaSdk`/`E2bSdk`
seam; the real client lives ONLY in `*-sdk.ts`. `openRun` boots ONE VM (Daytona from the promoted
`piflow-node-runtime` snapshot, E2B from a built template) whose image BAKES pi (`npm i -g
@earendil-works/pi-coding-agent`, bin `pi`). EXECUTE: `CLOUD_KINDS={daytona,e2b}` gates the runner;
each node gets a per-node-subtree `DaytonaSandbox`/`E2bSandbox` VIEW inside the shared VM, torn down
ONCE by `RunScope.dispose`. SECRETS: a cloud VM inherits no host env, so `cloudCredEnvAdditions`
resolves the DECLARED gateway-cred allowlist through the `SecretResolver` seam (`isCloud:true` lets a
host mint a scoped token) and crosses EXACTLY that set in via `CreateOpts.env`; `stageHome` writes
`~/.pi/agent/models.json` (with `$VAR` refs, never literal keys) so `--provider <gw>` resolves.

# Anchors
SELECT
- `packages/cli/src/run.ts:194` — `parseRunArgs` (`--sandbox`) — parse the backend choice (typo errors loudly)
- `packages/cli/src/run.ts:363` — `makeDaytonaProvider` — dynamic `import('@piflow/daytona')` → `createDaytonaProvider`
- `packages/cli/src/run.ts:377` — `makeE2bProvider` — dynamic `import('@piflow/e2b')` → `createE2bProvider`
INSTALL
- `packages/daytona/src/daytona.ts:540` — `DaytonaSandboxProvider.openRun` — boot ONE VM from snapshot/image per run
- `packages/e2b/src/e2b.ts:497` — `E2bSandboxProvider.openRun` — boot ONE E2B sandbox per run (open egress default)
- `deploy/daytona/Dockerfile:45` — `RUN npm install -g @earendil-works/pi-coding-agent` — bake pi into the VM image
EXECUTE
- `packages/core/src/runner/env-staging.ts:18` — `CLOUD_KINDS` — `{daytona,e2b}`: the no-host-trust gate
- `packages/core/src/runner/env-staging.ts:45` — `effectiveSandboxLocation` — per-node workdir/output by kind (isolated for cloud)
SECRETS
- `packages/core/src/types.ts:636` — `SecretResolver` — `(varName,{nodeId,isCloud}) => value`; mint scoped tokens cloud-side
- `packages/core/src/runner/env-staging.ts:141` — `cloudCredEnvAdditions` — resolve the DECLARED cred allowlist into the VM (cloud-only)

# Freshness (anti-drift)
anchors ✓ (all opened + line-verified in this worktree) · scope = the seeds above · re-derive when run.ts's sandbox dispatch or the provider `openRun`/`stageHome` shape changes. DRIFT NOTE: backends are UNEVEN — E2B is the most complete (full agent-in-sandbox LIVE-proven, `deploy/e2b/smoke-live.mjs` against template `riwrtwrfanz3tewd5pw6`, 2026-06-27); Daytona's image/snapshot is BUILT (`deploy/daytona/`, snapshot `piflow-node-runtime-0-80-2`) but bwrap-jail is blocked inside Daytona VMs (memory). LANGGRAPH IS NOT A CLOUD BACKEND: `@piflow/langgraph` only transports run-status into a LangGraph graph (no Sandbox/SandboxProvider, no `--sandbox` value) — excluded from this slice despite the prompt's starting list.

---
type: subsystem
key: claude-executor
title: Claude Code executor (route → build `claude -p` → spawn → parse stream-json → verdict)
description: How a node runs on headless `claude -p` instead of the pi fleet — dispatchCommand routes an executor:'claude-code' node to claudeCommand (claude -p --output-format stream-json), runNode injects the subscription OAuth credential and STRIPS the API keys, spawns it in the sandbox, and parseClaudeResult scans the NDJSON for the one `result` event into a ClaudeRunResult whose isError feeds the node verdict.
resource: packages/core/src/runner/claude-result.ts
aliases: [claude, "claude -p", claude-code, headless claude, claude executor, parseClaudeResult, ClaudeRunResult, findResultEvent, claudeCommand, dispatchCommand, claudeExecutorEnvAdditions, resolveClaudeOAuthToken, CLAUDE_CODE_OAUTH_TOKEN, rate_limit_event, stream-json, bypassPermissions, "executor: claude-code"]
seeds: [packages/core/src/runner/claude-result.ts, packages/core/src/runner/claude-executor.ts, packages/core/src/runner/command.ts, packages/core/src/runner/node-lifecycle.ts, packages/cli/src/claude-code.ts]
symbols: [parseClaudeResult, ClaudeRunResult, findResultEvent, claudeCommand, dispatchCommand, claudeExecutorEnvAdditions, resolveClaudeOAuthToken, runClaudeCodeCli]
tags: [claude, executor, runner, core, cli, lifecycle]
timestamp: 2026-07-01
---

# Why / how it works (the lifecycle, end to end)
A node opts into the Claude executor with `node.executor === 'claude-code'`. During `runNode` the SELECT is
twofold: `claudeExecutorEnvAdditions` resolves the subscription OAuth token host-side (`resolveClaudeOAuthToken`),
injects `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CONFIG_DIR`, and STRIPS `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` so
the jailed `claude -p` authenticates on the subscription and can never silently bill the API; and the node's
tier→model (owned by `per-node-routing-and-fusion`) flows in as `effModel`. The single `ctx.buildCommand` seam is
`dispatchCommand`, which routes `claude-code` → `claudeCommand` (else `defaultPiCommand`). `claudeCommand` BUILDs
`claude -p --permission-mode bypassPermissions --output-format stream-json --verbose`, appends `--model`
(`ctx.model`) and tool allow/deny, with the prompt piped on stdin. `ctx.execRunner` SPAWNs it inside the sandbox.
On exit, `parseClaudeResult` (via `findResultEvent`) scans the NDJSON for the single `type==='result'` event into a
normalized `ClaudeRunResult` (ok/isError/subtype/model/cost). The VERDICT ladder in `runNode` neuters the pi
self-report for a claude node (`parsed = null`) and fires the claude self-report clause only on a real error event —
a claude success still falls through to the executor-agnostic driver gates, so success never masks a contract breach.

# Anchors
SELECT (route + credential + model)
- `packages/core/src/runner/command.ts:164` — `dispatchCommand` — the one buildCommand seam; routes `node.executor==='claude-code'` → `claudeCommand`, else `defaultPiCommand`
- `packages/core/src/runner/node-lifecycle.ts:208` — `runNode` — builds the claude env additions (`claudeExecutorEnvAdditions`) before sandbox create
- `packages/core/src/runner/claude-executor.ts:124` — `claudeExecutorEnvAdditions` — injects `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CONFIG_DIR`, empties the API-key vars (subscription-only, never silent API billing)
- `packages/core/src/runner/claude-executor.ts:100` — `resolveClaudeOAuthToken` — layered host-side token resolve: SecretResolver env → `~/.piflow/claude-code.json` → local Keychain/`.credentials.json`
BUILD (`claude -p` command)
- `packages/core/src/runner/command.ts:133` — `claudeCommand` — assembles `claude -p --permission-mode bypassPermissions --output-format stream-json --verbose` (prompt on stdin)
- `packages/core/src/runner/command.ts:137` — `claudeCommand` — `if (ctx.model) parts.push('--model', ctx.model)` — the model wiring
SPAWN
- `packages/core/src/runner/node-lifecycle.ts:398` — `runNode` — `ctx.buildCommand(...)` (dispatch happens here) produces the command
- `packages/core/src/runner/node-lifecycle.ts:415` — `runNode` — `ctx.execRunner(execSandbox, cmd, …)` spawns claude inside the sandbox jail
PARSE
- `packages/core/src/runner/claude-result.ts:30` — `parseClaudeResult` — stream-json stdout → `ClaudeRunResult` (`ok = subtype==='success' && !isError`)
- `packages/core/src/runner/claude-result.ts:90` — `findResultEvent` — scans EVERY NDJSON line for `type==='result'` (never `tail -1`); skips blank/non-JSON, ignores `rate_limit_event`/assistant/system
- `packages/core/src/runner/claude-result.ts:15` — `ClaudeRunResult` — the normalized result/telemetry shape (ok, isError, subtype, sessionId, model, cost)
VERDICT
- `packages/core/src/runner/node-lifecycle.ts:571` — `runNode` — `isClaude` branch: `claudeVerdict = parseClaudeResult(result.stdout)`, `parsed = null` (neuters the pi self-report reader on stream-json)
- `packages/core/src/runner/node-lifecycle.ts:699` — `runNode` — `else if (claudeVerdict?.isError && claudeVerdict.subtype !== undefined) st = 'error'` — the claude self-report clause, gated on an ACTUAL result event

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · INVARIANT: a claude node's verdict comes from the single `type==='result'`
event, never `tail -1`/`lastJsonBlock` of the stream — `findResultEvent` selects only `type==='result'` and ignores
`rate_limit_event`/assistant/system (the fix for the `rate_limit_event misread → false gap` bug); so `runNode` sets
`parsed=null` for a claude node and the self-report clause fires ONLY on `isError && subtype!==undefined` (a real
result event reporting failure), while a result-less/truncated stdout is an ABSENT handshake left to the driver
artifact gate — a claude success never overrides the executor-agnostic driver gates. · DRIFT NOTE: this card OWNS
the claude executor delta only. `runner` owns the shared machinery it rides on (`defaultPiCommand`, the
CommandBuilder seam, the full `runNode` lifecycle + executor-agnostic verdict ladder, `ctx.execRunner`);
`per-node-routing-and-fusion` owns tier→model routing (`effModel` source). `runClaudeCodeCli`
(`packages/cli/src/claude-code.ts`) is the `piflowctl claude-code connect|status` CREDENTIAL subcommand, NOT the
spawn path. Open: escalation-on-claude (a claude node in the shared retry/escalate lanes, owned by `runner`).

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/runner/claude-result.ts` | ✓ |
| `packages/core/src/runner/claude-executor.ts` | ✓ |
| `packages/core/src/runner/command.ts` | ✓ |
| `packages/core/src/runner/node-lifecycle.ts` | ✓ |
| `packages/cli/src/claude-code.ts` | ✓ |

### Evolution arc

- `55eb576` 2026-06-21 — feat(core): M1 runner — execution loop over the spine
- `a4751de` 2026-06-21 — feat(core): wire outside tools end-to-end — resolve generates the -e, runner stages it + bind-gates each node
- `42f17a6` 2026-06-23 — feat(core): defaultPiCommand opts (thinking, extraExtensions) + --exclude-tools from resolved (U4)
- `b5972f2` 2026-06-26 — feat(skills): wire node.skill — stage the skill folder into the sandbox + emit --skill (reuse the seed seam)
- `56f1145` 2026-06-28 — feat(core): per-node pi session-id + warm-resume L1
- `716b9ec` 2026-06-28 — refactor(core): extract node-lifecycle from runner.ts (step 8/9)
- `51992b0` 2026-06-28 — feat: per-node stop — persist each node's pi pid, signal its group
- `4e9d4fd` 2026-06-28 — fix(core): in-place node runs IN the run dir so relative artifacts land under {{RUN}}
- `54747af` 2026-06-28 — fix(core): advertise in-place staged paths (MCP config, skill) under the run dir
- `22523e9` 2026-06-29 — Merge branch 'main' into worktree-feat+expert-representations
- `2051840` 2026-06-29 — feat(executor): claudeCommand builder for the claude-code executor
- `a0cd050` 2026-06-29 — feat(executor): parseClaudeResult — stream-json stdout → normalized result+telemetry
- `ca01064` 2026-06-29 — feat(executor): wire per-node executor selection (pi | claude-code) into dispatch
- `1adbe3f` 2026-06-29 — feat(executor): robust §7.2 credential model for claude-code (env token, API-key strip, isolated CLAUDE_CONFIG_DIR)
- `81200ca` 2026-06-29 — feat(cli): the skippable claude-code executor setup flow (connect + model --claude)
- `f9c63b1` 2026-06-29 — feat(cli): interactive, modular `piflowctl init` wizard (model tiers + optional claude-code)
- `4415ae9` 2026-06-29 — feat(core): per-node fullAccess flag — open the fs jail for one node
- `b4152e9` 2026-06-29 — fix(executor): a successful claude-code node reports `ok`, not a spurious `gap`
- `a935280` 2026-06-29 — merge: claude-code 2nd node executor + interactive piflowctl init wizard
- `25c4226` 2026-06-30 — feat(core): execCwd/execReads exec-scope for out-of-tree builds (E10)
- `e82e2b3` 2026-07-01 — feat(core): run-start executor override (pick pi|claude-code per node/run without editing the template)
- `81c5e1d` 2026-07-01 — fix(core): staged prompt/extension refs are workdir-absolute under execCwd (E10 bug #2)
- `0c9762f` 2026-07-01 — Merge branch 'main' into worktree-control-plane-serve-context
- `e021934` 2026-07-01 — feat(observe): distill each node's authored gates/policies into the config slice
- `7d7cd1e` 2026-07-01 — feat(observe): parseClaudeResult lifts ttft, stop_reason, and modelUsage contextWindow
- `76f6f0b` 2026-07-01 — feat(observe): persist Claude's result-event telemetry into the run record (NodeUsage spine)
- `2efc3f3` 2026-07-02 — test(P2): failing golden tests + claudeCodeDriver stub (RED)
- `5702dcb` 2026-07-02 — feat(P3): collapse the runtime fork onto ctx.drivers; open the executor type; stamp driver+version (GREEN)
- `0a00c73` 2026-07-02 — feat(P4): driverFits (2 axes) + schema --json agent + drivers catalog on /__piflow/agents.json (GREEN)
- `4c5def0` 2026-07-02 — feat(P5): driver-selected accumulator + Claude stream-json decode (count-only) + executor on the wire (GREEN)
- `bcc7657` 2026-07-02 — fix(core): consolidate run staging + sessions under one .pi/
- `152925f` 2026-07-02 — feat(core): per-node `thinking` — operator-free reasoning cap in node.json
- `abdb3ab` 2026-07-02 — refactor(core): kill the hardcoded 'cp' provider default — single system default = pi settings.json
- `5d1ef87` 2026-07-02 — fix(core): skill staging — collision-free naming for `.../SKILL.md` refs
- `ea146ff` 2026-07-02 — Merge feat/full-run-e2e: model default = the single system fixture (pi settings.json) + template-push + cloud plane
- `e1cf599` 2026-07-02 — feat(core+gui): agent identity on the live path + the hover card leads with what DEFINES the agent
- `7cf9fe8` 2026-07-03 — feat(core): unified skill locator — bare-id ring search, loud miss, ring/preset enumeration
- `3c2330e` 2026-07-03 — feat(observe): context-composition telemetry — the per-node "element tree"
- `d6842bc` 2026-07-05 — Merge feat/context-composition-telemetry — run-layout under .piflow, per-node thinking, node --rerun, context-composition telemetry, Leg-C method-library sync
- `6a45c20` 2026-07-05 — feat(core): wire script-tool preflight into node-lifecycle before the bind check
- `e4d5c2e` 2026-07-05 — feat(core): optional tools.defs entries — presence-based tool offering
- `980fe02` 2026-07-05 — fix(core): resolve contract.schema through the SAME token map as path
- `56c1d8e` 2026-07-06 — feat(optimize): M1 — run identity: date-seq names, lineage fields, child runs
- `fdc76dd` 2026-07-06 — merge main — pick up tools.defs schema + 40 upstream commits (worktree base predated the tool-wiring overhaul)
- `e4905f3` 2026-07-06 — feat(core): deterministic tool-loop circuit breaker on the run plane

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[blueprints-layer]]
- [[capability-catalog-feed]]
- [[claude-code-executor]]
- [[cloud-control-plane-local-cloud-switch]]
- [[competitive-gaps-pdw]]
- [[design-at-init-architecture]]
- [[expert-representations]]
- [[g6-agenttype-presets]]
- [[game-omni-reference-product]]
- [[github-native-issue-driven-flow]]
- [[gui-live-viewer-scope]]
- [[gui-nodehud-redesign]]
- [[guidance-node-sonnet5-routing]]
- [[loop-prevention-laws]]
- [[mastra-competitive-analysis]]
- [[omniscience-piflow-setup]]
- [[optimize-fixer-tier-finding]]
- [[optimize-loop-native-not-adhoc]]
- [[optimize-substrate-program]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[piflow-product-positioning]]
- [[piflow-rollout-enablement]]
- [[railway-deploy-from-main-not-worktree]]
- [[roadmap-bookkeeping-linear]]
- [[runs-live-in-product-runs-folder]]
- [[sdk-data-boundaries]]
- [[skill-marketplace-gui-design]]
- [[telemetry-legibility-tracks]]
- [[use-understanding-system-first]]

### Code anchors / blast radius (codegraph)

- `ClaudeRunResult` (packages/core/src/runner/claude-result.ts:15) — 3 callers in `packages/core/src/runner/claude-result.ts`; ⚠ no covering tests found
- `claudeCommand` (packages/core/src/runner/command.ts:135) — 2 callers in `packages/core/src/runner/index.ts`; tests: `packages/core/test/command-thinking.test.ts`
- `parseClaudeResult` (packages/core/src/runner/claude-result.ts:30) — 8 callers in `packages/core/src/runner/drivers/claude-code.ts`, `packages/core/src/optimize/substrate/agent.ts`; tests: `packages/core/test/claude-code-driver.test.ts`, `packages/core/test/claude-result.test.ts`, `packages/core/test/driver-parity.test.ts`
- `resolveClaudeOAuthToken` (packages/core/src/runner/claude-executor.ts:100) — 5 callers in `packages/core/src/runner/claude-executor.ts`, `packages/cli/src/cloud.ts`, `packages/core/src/runner/index.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/claude-executor.test.ts`
- `findResultEvent` (packages/core/src/runner/claude-result.ts:90) — 1 caller in `packages/core/src/runner/claude-result.ts`; ⚠ no covering tests found

<sub>derived 2026-07-07 · arc=45 commits · files=5 · lessons=32</sub>
<!-- okf:auto-end -->

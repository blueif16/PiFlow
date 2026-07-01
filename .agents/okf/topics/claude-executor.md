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
- `packages/core/src/runner/command.ts:154` — `dispatchCommand` — the one buildCommand seam; routes `node.executor==='claude-code'` → `claudeCommand`, else `defaultPiCommand`
- `packages/core/src/runner/node-lifecycle.ts:208` — `runNode` — builds the claude env additions (`claudeExecutorEnvAdditions`) before sandbox create
- `packages/core/src/runner/claude-executor.ts:124` — `claudeExecutorEnvAdditions` — injects `CLAUDE_CODE_OAUTH_TOKEN` + `CLAUDE_CONFIG_DIR`, empties the API-key vars (subscription-only, never silent API billing)
- `packages/core/src/runner/claude-executor.ts:100` — `resolveClaudeOAuthToken` — layered host-side token resolve: SecretResolver env → `~/.piflow/claude-code.json` → local Keychain/`.credentials.json`
BUILD (`claude -p` command)
- `packages/core/src/runner/command.ts:128` — `claudeCommand` — assembles `claude -p --permission-mode bypassPermissions --output-format stream-json --verbose` (prompt on stdin)
- `packages/core/src/runner/command.ts:137` — `claudeCommand` — `if (ctx.model) parts.push('--model', ctx.model)` — the model wiring
SPAWN
- `packages/core/src/runner/node-lifecycle.ts:398` — `runNode` — `ctx.buildCommand(...)` (dispatch happens here) produces the command
- `packages/core/src/runner/node-lifecycle.ts:415` — `runNode` — `ctx.execRunner(execSandbox, cmd, …)` spawns claude inside the sandbox jail
PARSE
- `packages/core/src/runner/claude-result.ts:21` — `parseClaudeResult` — stream-json stdout → `ClaudeRunResult` (`ok = subtype==='success' && !isError`)
- `packages/core/src/runner/claude-result.ts:62` — `findResultEvent` — scans EVERY NDJSON line for `type==='result'` (never `tail -1`); skips blank/non-JSON, ignores `rate_limit_event`/assistant/system
- `packages/core/src/runner/claude-result.ts:9` — `ClaudeRunResult` — the normalized result/telemetry shape (ok, isError, subtype, sessionId, model, cost)
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

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[blueprints-layer]]
- [[claude-code-executor]]
- [[competitive-gaps-pdw]]
- [[expert-representations]]
- [[g6-agenttype-presets]]
- [[game-omni-reference-product]]
- [[gui-live-viewer-scope]]
- [[mastra-competitive-analysis]]
- [[optimize-loop-native-not-adhoc]]
- [[piflow-ci-cd-pipeline]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-overlord-control-plane]]
- [[piflow-product-positioning]]
- [[piflow-rollout-enablement]]
- [[runs-live-in-product-runs-folder]]
- [[sdk-data-boundaries]]

### Code anchors / blast radius (codegraph)

- `ClaudeRunResult` (packages/core/src/runner/claude-result.ts:9) — 2 callers in `packages/core/src/runner/claude-result.ts`; ⚠ no covering tests found
- `claudeCommand` (packages/core/src/runner/command.ts:127) — 1 caller; tests: `packages/core/test/claude-command.test.ts`
- `findResultEvent` (packages/core/src/runner/claude-result.ts:52) — 1 caller in `packages/core/src/runner/claude-result.ts`; ⚠ no covering tests found
- `parseClaudeResult` (packages/core/src/runner/claude-result.ts:21) — 3 callers in `packages/core/src/runner/node-lifecycle.ts`; tests: `packages/core/test/claude-result.test.ts`
- `resolveClaudeOAuthToken` (packages/core/src/runner/claude-executor.ts:100) — 2 callers in `packages/core/src/runner/claude-executor.ts`; tests: `packages/core/test/claude-executor.test.ts`

<sub>derived 2026-07-01 · arc=20 commits · files=5 · lessons=17</sub>
<!-- okf:auto-end -->

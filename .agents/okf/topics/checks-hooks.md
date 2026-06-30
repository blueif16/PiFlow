---
type: subsystem
key: checks-hooks
title: Checks & hooks (the node action protocol — op[] → gate → policy)
description: How a node's canonical op[] is read into pre/post hooks and gate Checks, run as deterministic plumbing then evaluated as integrity gates over produced artifacts, with the verdict→action policy driving block/warn/stop and the retry/escalate FSM.
resource: packages/core/src/checks.ts
aliases: [checks, hooks, op, post-gate, policy.fail, node-action, io.checks, gatesFromOp, evaluateChecks, runHooks, classifyFailure]
seeds: [packages/core/src/checks.ts, packages/core/src/hooks/index.ts, packages/core/src/runner/op-dispatch.ts, packages/core/src/runner/node-lifecycle.ts, packages/core/src/runner/node-lanes.ts, packages/core/src/workflow/template/render.ts, packages/core/src/runner/retry.ts, packages/core/src/types.ts]
symbols: [evaluateChecks, effectiveChecks, actionForVerdict, classifyFailure, gatesFromOp, runHooks, collectChecks, CHECK_KINDS]
tags: [node-action, checks, hooks, gates, policy, runner, core]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
A node authors side-effects as a canonical `op[]` (`OpSpec`: `transform`/`run`/`gate`/`action`, each with a `when` lane).
`gatesFromOp` partitions gate ops into `pre` (fired over staged inputs BEFORE pi) and `post`; `collectChecks` (render)
folds the POST gates into `io.checks` — the deliberate TWO-LAYER design (op-authored post-gate ⇒ the same post-check
engine, closing the dead post-gate rep). At run time `runNode` (node-lifecycle) fires `node.hooks?.pre` via `runHooks`
(deterministic shell/fn plumbing, never an LLM; honors `when`/`idempotent`), runs the model, host-stats artifacts, then
evaluates `effectiveChecks(io.checks, fillSentinel, artifacts)` (explicit ∪ auto fill-sentinel) through `evaluateChecks`
over `CHECK_KINDS` (pure predicates: `non-empty`, `json-parses`, `count-floor`, …). `actionForVerdict(verdict, policy)`
maps each fail/warn → `block|warn|stop|retry|escalate`; blocking checks set status `blocked`. `runHooks(post)` then fires.
On non-ok, the captured `FailureSignals` feed `classifyFailure` → a `FailureClass` that the `retry`/`escalate` FSM filters.

# Anchors
DISPATCH
- `packages/core/src/runner/op-dispatch.ts:103` — `gatesFromOp` — partitions op[] gate bodies into pre/post `Check[]`
- `packages/core/src/workflow/template/render.ts:33` — `collectChecks` — folds op[] POST gates into `io.checks` (two-layer)
PRE
- `packages/core/src/runner/node-lifecycle.ts:353` — `runHooks(node.hooks?.pre …)` — deterministic pre-hook plumbing; blocking failure ⇒ error
- `packages/core/src/runner/node-lifecycle.ts:250` — `gatesFromOp(node.op).pre` — pre-gate fired over staged inputs before the model
POST
- `packages/core/src/hooks/index.ts:65` — `runHooks` — when/idempotent-honoring hook runner (also fired post at node-lifecycle.ts:683)
- `packages/core/src/runner/node-lifecycle.ts:517` — `evaluateChecks(effectiveChecks(io.checks, io.fillSentinel, …))` — the post-gate engine
GATE
- `packages/core/src/checks.ts:62` — `CHECK_KINDS` — pure predicate registry (exists/non-empty/json-parses/count-floor/…)
- `packages/core/src/checks.ts:138` — `effectiveChecks` — explicit checks ∪ the auto fill-sentinel completeness check
POLICY
- `packages/core/src/checks.ts:154` — `actionForVerdict` — verdict → `block|warn|stop|retry|escalate` via `io.policy`
- `packages/core/src/runner/node-lifecycle.ts:653` — `blockingChecks` clause in the status ladder ⇒ `blocked`
- `packages/core/src/checks.ts:203` — `classifyFailure` — failed checks → `quality-gap`, feeding `retry.ts` retry/escalate

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: `runNode` lives in `runner/node-lifecycle.ts` (NOT `runner.ts`, which only re-exports it at :296); the no-pi lanes in `node-lanes.ts` carry a PARALLEL copy of the pre-gate/check/hook blocks (:289/:391/:320/:429) — both must move together.

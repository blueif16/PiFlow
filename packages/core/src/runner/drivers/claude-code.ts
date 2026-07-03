// claude-code.ts — the `claude-code` AgentDriver (docs/design/agent-driver-registry.md §2.3, P2).
//
// The SECOND real driver — the per-node runtime strategy for the headless Claude Code executor. Each method is
// a THIN WRAPPER over a shipped claude function, so wiring the runner through this driver (P3) is byte-identical
// to today's dispatchCommand/effectiveModel ternaries: buildCommand → claudeCommand (the CommandBuilder seam,
// structural pass-through), resolveModel → resolveClaudeModel (a SELECTOR; precedence stays in model-routing.ts,
// mirroring the effectiveModel claude branch — provider is always undefined), parseResult →
// parseClaudeResult/nodeUsageFromClaude (Claude rolls up usage in this block — the observe spine), modelCaps →
// contextWindowFor (the fallback; the real per-run contextWindow rides usage from parseResult). The streaming
// stream-json accumulator is P5 (net-new), so eventAccumulator is absent for now. describe() is the claude
// static capability card, whose tools.builtinMap() is a GETTER over the ONE CLAUDE_TOOL_BY_PI_NAME const
// (imported live from command.ts — never a copy, §3). This phase is ADDITIVE ONLY: claude still runs via the
// existing dispatchCommand ternary (byte-identical); augmentSandbox is omitted (P3 defines + wires it).

import type { AgentDriver } from './types.js';
import { claudeCommand, CLAUDE_TOOL_BY_PI_NAME } from '../command.js';
import { resolveClaudeModel } from '../model-routing.js';
import { parseClaudeResult, nodeUsageFromClaude } from '../claude-result.js';
import { claudeExecutorEnvAdditions } from '../claude-executor.js';
import { contextWindowFor } from '../../observe/models.js';
import { createClaudeAccumulator } from '../../observe/claude-distill.js';

/**
 * The `claude-code` driver — wraps the shipped claude functions with ZERO behavior change. Registered under id
 * `claude-code`; `version` bumps only if buildCommand/eventAccumulator OUTPUT shape changes (sealing — §2.6).
 */
export const claudeCodeDriver: AgentDriver = {
  id: 'claude-code',
  version: 1,

  describe() {
    // The claude STATIC card (§2.5) — a-priori, product-agnostic, node-independent capability data.
    return {
      id: 'claude-code',
      label: 'Claude Code',
      version: 1,
      runtime: 'cli',
      binary: 'claude',
      // Claude is tier-aware (the `claude` tier block) but carries its own routing — no provider gateway; and
      // resolveClaudeModel is TOTAL (degrades to the account default rather than throwing on an unresolvable tier).
      model: { tierAware: true, providerRouting: false, resolvesThrows: false },
      tools: {
        grammar: 'claude-builtin',
        supportsCustom: true,
        supportsMcp: true,
        supportsSkills: true,
        // A GETTER over the ONE live CLAUDE_TOOL_BY_PI_NAME const (never a copy) — so a change to the source
        // const is reflected here, and the map can never drift from what claudeCommand actually maps.
        builtinMap: () => CLAUDE_TOOL_BY_PI_NAME,
        // `ls` has no Claude-native tool (Bash/Glob cover it) — the one pi builtin dropped by the map (command.ts:97).
        dropped: ['ls'],
      },
      // The claude credential coupling: inject the OAuth token, strip the API-key vars (subscription auth only),
      // and point CLAUDE_CONFIG_DIR at the jail. Local sandbox only (builtins, already-logged-in subscription).
      sandbox: {
        providers: ['local'],
        authInjectEnv: ['CLAUDE_CODE_OAUTH_TOKEN'],
        stripEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
        configDir: 'CLAUDE_CONFIG_DIR',
      },
      // Claude DOES roll up usage in parseResult — the token/cost/context spine off the ONE `result` event
      // (usageRollup:true). The per-tool timeline is count-only (no tool_execution_end in the stream).
      telemetry: { usageRollup: true, perToolTimeline: 'count-only', loopSignal: true, costReported: true },
      costModel: 'subscription-flat',
    };
  },

  // SELECTS the claude resolver; precedence is NOT re-encoded here — it stays in model-routing.ts's one home.
  // Mirrors the effectiveModel claude branch: provider is always undefined (Claude's model carries its routing).
  resolveModel(node, run) {
    return { model: resolveClaudeModel(node, run), provider: undefined };
  },

  // The CommandBuilder seam — a true pass-through to claudeCommand (byte-identical by construction).
  buildCommand(node, resolved, ctx, opts) {
    return claudeCommand(node, resolved, ctx, opts);
  },

  // (P3) The pre-spawn credential coupling — a THIN WRAPPER over the shipped `claudeExecutorEnvAdditions`
  // (§7.2 model): inject CLAUDE_CODE_OAUTH_TOKEN, strip the API-key vars, point CLAUDE_CONFIG_DIR at the
  // per-node jail dir. Byte-identical to the node-lifecycle:242 call site it replaces — same inputs, same
  // additions. `read`/`write` are reserved (unused in P3); only `env` is consumed by the run-side merge.
  async augmentSandbox(spec) {
    const env = await claudeExecutorEnvAdditions({
      executor: spec.node.executor,
      nodeId: spec.nodeId,
      configDir: spec.configDir,
      resolver: spec.resolver,
    });
    return { env };
  },

  // Claude's verdict + usage ride the ONE authoritative `result` event: ok/sessionId from the parsed result,
  // usage the NodeUsage spine (token/cost/context) the observe surface reads. selfReport is null (Claude's
  // verdict rides isError + the artifact-stat gates, not a self-reported JSON block). (P3) `selfReportedError`
  // carries the result-event error (isError && subtype present) so the status ladder reproduces the claude
  // self-reported-error clause without a claude-specific fork.
  parseResult(raw) {
    const cv = parseClaudeResult(raw.stdout);
    const verdict: import('./types.js').AgentVerdict = { ok: cv.ok, selfReport: null, sessionId: cv.sessionId };
    // Populate ONLY when the result event was PRESENT (subtype !== undefined) and reported a failure —
    // the EXACT guard the old ladder clause used. `subtype`/`text` are carried verbatim so the ladder's
    // issue string is byte-identical (a result-less isError has subtype undefined ⇒ left unset ⇒ the
    // driver gates own the produced-nothing case, exactly as before).
    if (cv.isError && cv.subtype !== undefined) {
      verdict.selfReportedError = { subtype: cv.subtype, ...(cv.text !== undefined ? { text: cv.text } : {}) };
    }
    return { verdict, usage: nodeUsageFromClaude(cv) };
  },

  // (P5) The streaming Claude stream-json accumulator — the count-only twin of pi's createNodeAccumulator.
  // It decodes the NESTED tool blocks (assistant `tool_use` opens a span, the matching user `tool_result`
  // closes it) into toolBreakdown + a tool SEQUENCE + maxToolRepeat, every span durMs:0 (the §4.1 count-only
  // ceiling — Claude carries no per-tool end timestamp). Token/cost/model ride rec.usage (nodeTokenSpine),
  // NOT this reducer, so nothing double-sources from the slimmed stream. A blank Claude node becomes a real
  // tool list, folded through the SAME assembleNode as pi.
  eventAccumulator() {
    return createClaudeAccumulator();
  },

  // The context-window denominator FALLBACK when the run didn't self-report one (the real per-run
  // contextWindow rides usage from parseResult — the modelUsage[model].contextWindow off the result event).
  modelCaps(model, catalog) {
    return contextWindowFor(model, catalog);
  },

  // (Defect E1) Recognize Claude's stream-json vocabulary from a parsed sample — an UNSTAMPED legacy run
  // (no driverId, e.g. game-omni's old engine) is format-DETECTED here instead of silently folding through
  // pi's no-op accumulator. 'assistant'/'result' are top-level event types pi NEVER emits (pi's vocabulary is
  // message_start/message_end/tool_execution_*/thinking_delta/auto_retry_start — distill.ts), so their
  // presence is an unambiguous Claude stream-json signal.
  sniffsEvents(sample) {
    return sample.some((e) => e && (e.type === 'assistant' || e.type === 'result'));
  },
};

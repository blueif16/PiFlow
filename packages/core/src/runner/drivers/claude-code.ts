// claude-code.ts — the `claude-code` AgentDriver (docs/design/agent-driver-registry.md §2.3, P2).
//
// P2 STUB (RED). This is a WRONG-BUT-NON-THROWING placeholder so the P2 golden tests COMPILE and run RED for
// the missing-behavior reason (a FAIL, not an import/type error). The REAL bodies — each a THIN WRAPPER over a
// shipped claude function (buildCommand → claudeCommand, resolveModel → resolveClaudeModel, parseResult →
// parseClaudeResult/nodeUsageFromClaude, modelCaps → contextWindowFor, describe() = the claude static card whose
// tools.builtinMap() is a GETTER over the ONE CLAUDE_TOOL_BY_PI_NAME const, never a copy) — are the NEXT agent's
// job. This phase is ADDITIVE ONLY; claude still runs via the existing dispatchCommand ternary (byte-identical).

import type { AgentDriver } from './types.js';

/**
 * The `claude-code` driver — STUB (P2 RED). Deliberately wrong so the golden tests FAIL cleanly; the next
 * agent replaces each body with its thin wrapper. Registered under a STUB id so the table wiring compiles
 * without the (yet-unbuilt) real driver silently going green.
 */
export const claudeCodeDriver: AgentDriver = {
  // WRONG id on purpose: the real driver registers under 'claude-code'. Keeps the table-wiring test RED.
  id: 'claude-code-STUB',
  version: 1,

  describe() {
    // STUB card — wrong on every load-bearing field the tests assert (builtinMap is {} not the live const,
    // dropped absent, etc.) so describe()-driven tests fail cleanly.
    return {
      id: 'claude-code-STUB',
      label: 'STUB',
      version: 1,
      runtime: 'cli',
      binary: 'claude',
      model: { tierAware: false, providerRouting: false, resolvesThrows: false },
      tools: {
        grammar: 'claude-builtin',
        supportsCustom: false,
        supportsMcp: false,
        supportsSkills: false,
        // WRONG: the real getter returns the live CLAUDE_TOOL_BY_PI_NAME const. Empty ⇒ test 5 fails cleanly.
        builtinMap: () => ({}),
      },
      // WRONG sandbox: the real card injects/strips the Claude creds.
      sandbox: { providers: [] },
      // usageRollup:true is REQUIRED to be honest, but the STUB parseResult returns no usage ⇒ conformsToParity
      // FAILS (test 4 red for the right reason: promise-vs-delivery gap).
      telemetry: { usageRollup: true, perToolTimeline: 'count-only', loopSignal: false, costReported: true },
      costModel: 'subscription-flat',
    };
  },

  // WRONG: the real body returns claudeCommand(...). A non-claude string ⇒ test 1 fails cleanly.
  buildCommand() {
    return 'STUB';
  },

  // WRONG: the real body returns { model: resolveClaudeModel(node, run), provider: undefined }. ⇒ test 2 fails.
  resolveModel() {
    return {};
  },

  // WRONG: the real body wraps parseClaudeResult + nodeUsageFromClaude. No usage ⇒ tests 3 & 4 fail cleanly.
  parseResult() {
    return { verdict: { ok: false, selfReport: null }, usage: undefined };
  },

  // The streaming Claude accumulator is P5 (net-new) — absent for now, as the spec declares.
  eventAccumulator() {
    return undefined;
  },

  // WRONG: the real body returns contextWindowFor(model, catalog).
  modelCaps() {
    return null;
  },
};

// pi.ts — the `pi` AgentDriver (docs/design/agent-driver-registry.md §2.3, P1).
//
// STUB (P1 test-first): this file exists so the P1 tests COMPILE and run RED for the missing-behavior reason.
// The REAL bodies WRAP the shipped pi functions with ZERO behavior change — buildCommand → defaultPiCommand,
// resolveModel → resolveNodeModel (a THIN selector; precedence stays in model-routing.ts), eventAccumulator →
// createNodeAccumulator, parseResult → lastJsonBlock (usage undefined; pi telemetry rides the event fold),
// modelCaps → contextWindowFor, describe() → the pi static card. The next agent replaces these placeholders.

import type { AgentDriver } from './types.js';

/**
 * The `pi` driver — the per-node runtime strategy for the pi coding agent. STUB bodies return
 * WRONG-BUT-NON-THROWING placeholders (buildCommand → the literal "STUB", etc.) so the tests fail on the
 * assertion, not on an import/type error.
 */
export const piDriver: AgentDriver = {
  id: 'pi',
  version: 1,

  describe() {
    // STUB: not the real pi static card.
    return {
      id: 'pi',
      label: 'pi',
      version: 1,
      runtime: 'cli',
      binary: 'pi',
      model: { tierAware: true, providerRouting: true, resolvesThrows: true },
      tools: {
        grammar: 'pi-bare',
        supportsCustom: true,
        supportsMcp: true,
        supportsSkills: true,
        builtinMap: () => ({}),
      },
      sandbox: { providers: ['local'] },
      // STUB: the real card declares usageRollup:false, perToolTimeline:'full'. Kept parity-conforming shape.
      telemetry: { usageRollup: false, perToolTimeline: 'full', loopSignal: true, costReported: true },
      costModel: 'per-token',
    };
  },

  // STUB: returns nothing; the real body delegates to resolveNodeModel(node, run).
  resolveModel(_node, _run) {
    return {};
  },

  // STUB: returns a fixed literal; the real body delegates to defaultPiCommand(node, resolved, ctx, opts).
  buildCommand(_node, _resolved, _ctx, _opts) {
    return 'STUB';
  },

  // STUB: returns a verdict with a null selfReport + usage undefined; the real body reads lastJsonBlock(raw.stdout).
  parseResult(_raw) {
    return { verdict: { ok: true, selfReport: null }, usage: undefined };
  },

  // STUB: returns undefined; the real body returns createNodeAccumulator().
  eventAccumulator() {
    return undefined;
  },

  // STUB: returns null; the real body delegates to contextWindowFor(model, catalog).
  modelCaps(_model, _catalog) {
    return null;
  },
};

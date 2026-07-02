// pi.ts — the `pi` AgentDriver (docs/design/agent-driver-registry.md §2.3, P1).
//
// The FIRST real driver — the per-node runtime strategy for the pi coding agent. Each method is a THIN
// WRAPPER over a shipped pi function, so wiring the runner through this driver (P2/P3) is byte-identical to
// today: buildCommand → defaultPiCommand (the CommandBuilder seam, structural pass-through), resolveModel →
// resolveNodeModel (a SELECTOR; precedence stays in model-routing.ts, the one home), eventAccumulator →
// createNodeAccumulator, parseResult → lastJsonBlock (usage undefined — pi telemetry rides the events.jsonl
// fold, not this block), modelCaps → contextWindowFor. describe() is the pi static capability card.

import type { AgentDriver } from './types.js';
import { defaultPiCommand } from '../command.js';
import { resolveNodeModel } from '../model-routing.js';
import { lastJsonBlock } from '../return-parse.js';
import { createNodeAccumulator } from '../../observe/distill.js';
import { contextWindowFor } from '../../observe/models.js';

/**
 * The `pi` driver — wraps the shipped pi functions with ZERO behavior change. Registered under id `pi`;
 * `version` bumps only if buildCommand/eventAccumulator OUTPUT shape changes (sealing — §2.6).
 */
export const piDriver: AgentDriver = {
  id: 'pi',
  version: 1,

  describe() {
    // The pi STATIC card (§2.5) — a-priori, product-agnostic, node-independent capability data.
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
        // pi uses bare pi tool names — no name remap, so the map is empty.
        builtinMap: () => ({}),
      },
      sandbox: { providers: ['local'] },
      // pi does NOT roll up usage in parseResult — telemetry rides the events.jsonl fold (usageRollup:false),
      // and the per-tool timeline carries real durations (tool_execution_end present ⇒ 'full').
      telemetry: { usageRollup: false, perToolTimeline: 'full', loopSignal: true, costReported: true },
      costModel: 'per-token',
    };
  },

  // SELECTS the resolver; precedence is NOT re-encoded here — it stays in model-routing.ts's one home.
  resolveModel(node, run) {
    return resolveNodeModel(node, run);
  },

  // The CommandBuilder seam — a true pass-through to defaultPiCommand (byte-identical by construction).
  buildCommand(node, resolved, ctx, opts) {
    return defaultPiCommand(node, resolved, ctx, opts);
  },

  // pi's verdict is its own self-report (the fenced JSON block); usage is undefined (the event fold wins).
  parseResult(raw) {
    const block = lastJsonBlock(raw.stdout);
    const selfReport = block
      ? { status: block.status ?? '', summary: block.summary, issues: block.issues }
      : null;
    return { verdict: { ok: raw.exitCode === 0 && raw.killed === null, selfReport }, usage: undefined };
  },

  // A streaming accumulator over the persisted events.jsonl (push/snapshot/finalize).
  eventAccumulator() {
    return createNodeAccumulator();
  },

  // The context-window denominator when the run didn't self-report one.
  modelCaps(model, catalog) {
    return contextWindowFor(model, catalog);
  },
};

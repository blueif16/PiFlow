// Contract for optimize/long-horizon.ts — the LONG-HORIZON outer loop (the counterpart to the multi-round inner
// loop). Each GENERATION runs the inner optimization loop on workflow W, then an INJECTED redesign subgraph emits
// the next workflow's blueprint; the loop continues on that new template until converged / the generation budget /
// no redesign seam. Thin deterministic outer driver; the redesign SUBGRAPH is injected + deferred (the STOP).
// Tests use in-memory FAKE stages (real functions that record calls + return canned shapes) — no mocks.
//
// Run: npx vitest run packages/core/test/optimize-long-horizon.test.ts

import { describe, it, expect } from 'vitest';
import { runLongHorizon, type LongHorizonStages, type NextWorkflowPlan } from '../src/optimize/long-horizon.js';
import type { OptimizeLoopResult } from '../src/optimize/loop.js';

const loopResult = (): OptimizeLoopResult => ({
  rounds: [], trajectory: [], stoppedReason: 'budget-exhausted', roundsRun: 1,
});

describe('runLongHorizon — the STOP: no redesign subgraph ⇒ exactly one generation', () => {
  it('runs ONE generation (the inner loop) and stops with no-redesign-seam when no redesign is injected', async () => {
    const seen: Array<{ gen: number; dir: string }> = [];
    const stages: LongHorizonStages = {
      runGeneration: async (generation, templateDir) => { seen.push({ gen: generation, dir: templateDir }); return loopResult(); },
      // no redesign — the deferred self-design seam is absent.
    };

    const res = await runLongHorizon(stages, { templateDir: '/wf/W', maxGenerations: 5 });

    expect(res.stoppedReason).toBe('no-redesign-seam');
    expect(res.generationsRun).toBe(1);
    expect(seen).toEqual([{ gen: 1, dir: '/wf/W' }]); // one generation, on the seed workflow, despite budget 5
    expect(res.generations[0]?.plan).toBeUndefined(); // the terminal generation carries no plan
  });
});

describe('runLongHorizon — with a redesign subgraph, it continues on the newly-designed workflow', () => {
  it('threads redesign.nextTemplate into the next generation, until the budget ceiling', async () => {
    const optimized: string[] = [];
    // redesign always hands off to a fresh template W2, W3, … so the loop keeps going until the budget.
    const stages: LongHorizonStages = {
      runGeneration: async (_gen, templateDir) => { optimized.push(templateDir); return loopResult(); },
      redesign: async ({ generation }): Promise<NextWorkflowPlan> =>
        ({ done: false, nextTemplate: `/wf/W${generation + 1}`, rationale: `designed gen ${generation + 1}` }),
    };

    const res = await runLongHorizon(stages, { templateDir: '/wf/W1', maxGenerations: 3 });

    expect(res.stoppedReason).toBe('generation-budget');
    expect(res.generationsRun).toBe(3);
    // each generation optimized the workflow the PRIOR redesign authored (W1 → W2 → W3).
    expect(optimized).toEqual(['/wf/W1', '/wf/W2', '/wf/W3']);
    expect(res.generations[2]?.plan?.nextTemplate).toBe('/wf/W4');
  });

  it('stops (converged) as soon as redesign returns done=true', async () => {
    const stages: LongHorizonStages = {
      runGeneration: async () => loopResult(),
      // converge on generation 2.
      redesign: async ({ generation }): Promise<NextWorkflowPlan> =>
        generation < 2
          ? { done: false, nextTemplate: `/wf/W${generation + 1}`, rationale: 'keep going' }
          : { done: true, rationale: 'no better workflow to design' },
    };

    const res = await runLongHorizon(stages, { templateDir: '/wf/W1', maxGenerations: 10 });

    expect(res.stoppedReason).toBe('converged');
    expect(res.generationsRun).toBe(2); // converged at gen 2, not the full 10
  });

  it('stops (converged) when redesign says continue but provides NO next template (nothing to run)', async () => {
    const stages: LongHorizonStages = {
      runGeneration: async () => loopResult(),
      redesign: async (): Promise<NextWorkflowPlan> => ({ done: false, rationale: 'wanted to continue but authored nothing' }),
    };

    const res = await runLongHorizon(stages, { templateDir: '/wf/W1', maxGenerations: 10 });

    expect(res.stoppedReason).toBe('converged'); // no nextTemplate ⇒ nothing to optimize next ⇒ stop
    expect(res.generationsRun).toBe(1);
  });
});

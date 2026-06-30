// The init orchestrator — capability-agnostic. It walks the step registry in order and gates each OPTIONAL
// step behind its enable prompt. This is the ONLY place the "optional check" semantics live: a declined gate
// records `skipped` and NEVER calls the step's `run` (so a skipped Claude Code step touches no files — the
// pure-pi default is preserved). A core step always runs. Returns the per-step results for the wrap-up.

import type { InitStep, InitContext, StepResult } from './types.js';

export async function runInitSteps(steps: InitStep[], ctx: InitContext): Promise<StepResult[]> {
  const results: StepResult[] = [];
  for (const step of steps) {
    ctx.io.print(`\n${step.title}`);
    if (step.optional) {
      const enable = await ctx.io.confirm(step.gate ?? `Configure ${step.id}?`, false);
      if (!enable) {
        ctx.io.print('  skipped.');
        results.push({ id: step.id, status: 'skipped', detail: 'skipped' });
        continue;
      }
    }
    results.push(await step.run(ctx));
  }
  return results;
}

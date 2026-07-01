// optimize/long-horizon.ts — the LONG-HORIZON outer loop (the counterpart to the multi-round inner loop).
//
// The multi-round loop (loop.ts) OPTIMIZES a FIXED workflow across N rounds. The long-horizon loop is the OUTER
// counterpart: each GENERATION runs the inner optimization loop on workflow W, then a REDESIGN subgraph analyzes
// what happened across the generation's runs and EMITS THE BLUEPRINT / TEMPLATE OF THE NEXT WORKFLOW W' (dive into
// the previous nodes → analyze what happened → design future nodes → author the next template). The loop then
// continues on W', W'', … — this is the long-horizon task, the self-designing substrate. It is L2 COMPOSE / the
// reconcile step (piflow-memory-v1.5 §6: "between rounds: reconcile — the ONLY step that edits the template"),
// lifted from a between-rounds step to its own outer loop.
//
// THE STOP (2026-07-01): this pins the CONTRACT + the thin, deterministic outer driver — but the REDESIGN subgraph
// (the agent/workflow that reads the run history and AUTHORS the next blueprint) is INJECTED and DEFERRED. That
// injected stage is where the self-design intelligence will live (product-side, like the fixer). Without a redesign
// stage the loop runs exactly ONE generation (= the inner multi-round loop) and stops — a clean seam, never a
// half-built feature. Kept THIN on purpose: the outer driver only SEQUENCES generations and threads the next
// template; all intelligence (analyze-past → design-next) is in the injected redesign subgraph.

import type { OptimizeLoopResult } from './loop.js';

/** The plan a REDESIGN subgraph emits after a generation: the next workflow's blueprint, or "converged → stop". */
export interface NextWorkflowPlan {
  /** true ⇒ the long-horizon loop has converged (no better next workflow to design); stop. */
  done: boolean;
  /** a POINTER to the next workflow's authored template/blueprint (e.g. a template dir); required when done=false. */
  nextTemplate?: string;
  /** one-line why — the analyze-past → design-next rationale, for the human + the generation trajectory. */
  rationale: string;
}

/**
 * The INJECTED redesign subgraph — analyze a completed generation (its inner-loop result + the run history under
 * `templateDir`) and author the NEXT workflow's blueprint. This is the SELF-DESIGN stage: an agent/workflow, so it
 * is product-side and DEFERRED (the long-horizon STOP). Core never authors a template; it only threads the pointer
 * this stage returns. Absent ⇒ the outer loop runs one generation and stops (no-redesign-seam).
 */
export type RedesignStage = (input: {
  generation: number;
  /** the workflow template this generation optimized. */
  templateDir: string;
  /** the inner multi-round loop's result for this generation (the raw material the redesign analyzes). */
  loopResult: OptimizeLoopResult;
}) => Promise<NextWorkflowPlan>;

/** The INJECTED inner stage — run ONE generation's multi-round optimization loop on `templateDir` → its result. */
export type RunGeneration = (generation: number, templateDir: string) => Promise<OptimizeLoopResult>;

export interface LongHorizonStages {
  runGeneration: RunGeneration;
  /** the DEFERRED self-design seam; absent ⇒ the loop runs one generation and stops (the STOP). */
  redesign?: RedesignStage;
}

export interface LongHorizonOpts {
  /** the workflow the FIRST generation optimizes. */
  templateDir: string;
  /** max generations — the outer budget ceiling. Default 1 (a single generation = today's inner-loop behavior). */
  maxGenerations?: number;
}

/** One generation's record: which workflow it optimized, the inner-loop result, and the redesign plan (if any). */
export interface GenerationRecord {
  generation: number;
  templateDir: string;
  loopResult: OptimizeLoopResult;
  /** the plan the redesign emitted; absent on the terminal generation when no redesign stage was injected. */
  plan?: NextWorkflowPlan;
}

export type LongHorizonStopReason = 'converged' | 'generation-budget' | 'no-redesign-seam';

export interface LongHorizonResult {
  generations: GenerationRecord[];
  stoppedReason: LongHorizonStopReason;
  generationsRun: number;
}

/**
 * Drive up to `opts.maxGenerations` generations. Each generation: run the inner optimization loop on the current
 * workflow, then (if a redesign subgraph is injected) author the next workflow and continue on it. Stops when the
 * redesign converges (done, or no next template), the generation budget is hit, or — the STOP — no redesign stage
 * exists (one generation, then stop). Thin + deterministic; the analyze-past → design-next intelligence is entirely
 * in the injected redesign stage.
 */
export async function runLongHorizon(stages: LongHorizonStages, opts: LongHorizonOpts): Promise<LongHorizonResult> {
  const maxGenerations = opts.maxGenerations ?? 1;
  const generations: GenerationRecord[] = [];
  let templateDir = opts.templateDir;
  let stoppedReason: LongHorizonStopReason = 'generation-budget';
  let generationsRun = 0;

  for (let generation = 1; generation <= maxGenerations; generation++) {
    generationsRun = generation;
    const loopResult = await stages.runGeneration(generation, templateDir);

    // THE STOP: no redesign subgraph ⇒ this generation is the end. The inner loop ran; the self-design that would
    // author the next workflow is the DEFERRED seam, so we stop cleanly rather than pretend to design one.
    if (!stages.redesign) {
      generations.push({ generation, templateDir, loopResult });
      stoppedReason = 'no-redesign-seam';
      break;
    }

    const plan = await stages.redesign({ generation, templateDir, loopResult });
    generations.push({ generation, templateDir, loopResult, plan });

    // CONVERGED — the redesign found no better next workflow (done), or authored no next template to run.
    if (plan.done || !plan.nextTemplate) { stoppedReason = 'converged'; break; }

    templateDir = plan.nextTemplate; // continue on the newly-designed workflow W'
  }

  return { generations, stoppedReason, generationsRun };
}

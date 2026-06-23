// ─────────────────────────────────────────────────────────────────────────────
// runFromConfig — the ENV-AGNOSTIC run entry (D5 / sdk-canonical-build-plan U8).
//
// A LIBRARY consumer passes a PLAIN resolved-config OBJECT; core compiles the WorkflowSpec and runs it via
// the existing `runWorkflow`. There is NO env parsing here — that is `loadConfig`'s job (the CLI/convention
// layer). The WORKFLOW BRIDGE stays CONSUMER-INJECTED: the consumer supplies either a literal `workflowSpec`
// or a `buildWorkflowSpec` factory (the workflow-dialect-specific bit core does NOT own). `runFromConfig` is
// the clean seam the `piflow run` CLI subcommand (the follow-on unit) calls after it resolves the env.
// ─────────────────────────────────────────────────────────────────────────────

import type { WorkflowSpec } from '../types.js';
import { compile } from '../dag.js';
import { runWorkflow, type RunOptions, type RunResult } from './runner.js';

/**
 * The resolved-config object `runFromConfig` consumes: a WorkflowSpec SOURCE (consumer-injected — either a
 * literal `workflowSpec` or a `buildWorkflowSpec` factory) plus every `runWorkflow` knob (provider/sandbox,
 * providerName, model, thinking, from/until, timeouts, registry, returnProtocol, …). No env fields — those
 * are resolved upstream by `loadConfig`.
 */
export type ResolvedRunConfig = RunOptions &
  (
    | { workflowSpec: WorkflowSpec; buildWorkflowSpec?: never }
    | { buildWorkflowSpec: () => WorkflowSpec | Promise<WorkflowSpec>; workflowSpec?: never }
    | { workflowSpec?: WorkflowSpec; buildWorkflowSpec?: () => WorkflowSpec | Promise<WorkflowSpec> }
  );

/**
 * Build/use the WorkflowSpec from the resolved config, compile it, and run it via `runWorkflow`. Returns
 * the run result. Fails LOUDLY (never a silent no-op) if NEITHER spec source is provided.
 */
export async function runFromConfig(config: ResolvedRunConfig): Promise<RunResult> {
  const { workflowSpec, buildWorkflowSpec, ...runOpts } = config as ResolvedRunConfig & {
    workflowSpec?: WorkflowSpec;
    buildWorkflowSpec?: () => WorkflowSpec | Promise<WorkflowSpec>;
  };

  let spec: WorkflowSpec;
  if (workflowSpec) {
    spec = workflowSpec;
  } else if (buildWorkflowSpec) {
    spec = await buildWorkflowSpec();
  } else {
    throw new Error(
      'runFromConfig: no workflow source — provide `workflowSpec` or `buildWorkflowSpec` (the bridge is consumer-injected).',
    );
  }

  const workflow = compile(spec);
  return runWorkflow(workflow, runOpts as RunOptions);
}

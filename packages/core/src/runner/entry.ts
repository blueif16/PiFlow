// ─────────────────────────────────────────────────────────────────────────────
// runFromConfig — the ENV-AGNOSTIC run entry (D5 / sdk-canonical-build-plan U8).
//
// A LIBRARY consumer passes a PLAIN resolved-config OBJECT; core compiles the WorkflowSpec and runs it via
// the existing `runWorkflow`. There is NO env parsing here — that is `loadConfig`'s job (the CLI/convention
// layer). The WORKFLOW BRIDGE stays CONSUMER-INJECTED: the consumer supplies either a literal `workflowSpec`
// or a `buildWorkflowSpec` factory (the workflow-dialect-specific bit core does NOT own). `runFromConfig` is
// the clean seam the `piflow run` CLI subcommand (the follow-on unit) calls after it resolves the env.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'node:path';
import type { WorkflowSpec } from '../types.js';
import { compile } from '../dag.js';
import { loadTemplate } from '../workflow/template/loader.js';
import { instantiateRun } from '../workflow/template/instantiate.js';
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

/**
 * Options for `runFromTemplate` — the `runWorkflow` knobs PLUS the run-dir / workspace the template join
 * needs. `runDir` is the physical run root (= `{{RUN}}`, where `.pi/nodes/<id>/` is materialized AND the run
 * collects its artifacts) — it is the SAME path passed as `outDir` to `runWorkflow`. `workspace` is the
 * `{{WORKSPACE}}` root the template's tokens resolve against (default `runWorkflow`'s repoRoot default).
 */
export interface RunFromTemplateOpts extends RunOptions {
  /** The physical run root (= `{{RUN}}` / `outDir`). The `.piflow/<wf>/runs/<id>/` convention is a CLI default, NOT core's. */
  runDir: string;
}

/**
 * THE TEMPLATE-RUN JOIN (U8 / §10) — load a structured workflow TEMPLATE and run it end-to-end:
 *   loadTemplate(dir) → instantiateRun(dir, runDir, {workspace}) → compile(spec) → runWorkflow(wf, {…}).
 *
 * This is the one entry that connects the TWO previously-disconnected halves: `loadTemplate` makes the
 * WorkflowSpec (the DAG + contracts) and `instantiateRun` materializes the `${RUN}/.pi/nodes/<id>/` thread
 * folder — neither alone runs the template. `runDir` is threaded as BOTH the instantiate target AND the
 * runWorkflow `outDir` (one physical run root = `{{RUN}}`). Core stays generic: the `.piflow/<wf>/runs/<id>/`
 * home (D9) is a CLI/init default the caller passes in as `runDir`, never hardcoded here. `runFromConfig`
 * (the consumer-injected WorkflowSpec path) is left intact for library consumers that already hold a spec.
 */
export async function runFromTemplate(templateDir: string, opts: RunFromTemplateOpts): Promise<RunResult> {
  const { runDir, ...runOpts } = opts;
  const workspace = opts.workspace ?? opts.repoRoot ?? process.cwd();
  // (1) compile the template → WorkflowSpec (fail-closed §8 gate).
  const spec = await loadTemplate(templateDir);
  // (2) materialize the run thread folder (${RUN}/.pi/nodes/<id>/ + the empty state stub).
  await instantiateRun(templateDir, runDir, { workspace });
  // (3) build the DAG + (4) run it, collecting into the SAME run root.
  const workflow = compile(spec);
  return runWorkflow(workflow, { ...(runOpts as RunOptions), outDir: path.resolve(runDir), workspace });
}

// `piflowctl extract <templateDir>` — the FREE DAG preview (no model invoked). The template-era equivalent
// of the old `extract.mjs`: load the authored template through @piflow/core's compile gate
// (`loadTemplate(dir) → WorkflowSpec`), `compile` it into the topological DAG, and RENDER the realized
// stages — node count, each stage's node ids, and which stages are PARALLEL lanes (write-disjoint
// siblings on one topological level). Run it before any live run to prove the extraction matches the
// workflow you authored; it spawns NO pi, costs nothing.
//
// This is a THIN renderer over the core seam — it reimplements NO graph logic (loadTemplate runs the §8
// static checks + compile derives the stages). It only lays the compiled `Workflow.stages` out as text.

import { loadTemplate, compile, type Workflow } from '@piflow/core';

/** Render a compiled `Workflow`'s stages/DAG as the free preview text (pure over the workflow). */
export function renderDag(wf: Workflow): string {
  const nodeCount = Object.keys(wf.nodes).length;
  const stageCount = wf.stages.length;
  const head = [
    `workflow "${wf.meta.name}" — ${nodeCount} nodes · ${stageCount} stages (free DAG preview, no model)`,
    wf.meta.description ? `  ${wf.meta.description}` : null,
  ].filter((l): l is string => l !== null);

  const lines = wf.stages.map((s) => {
    const lane = s.parallel ? '  ‖ parallel' : '';
    const ids = s.nodeIds.join(', ');
    return `  stage ${s.index}/${stageCount}${lane}  ·  [${ids}]`;
  });

  return [...head, ...lines].join('\n');
}

/**
 * Load + compile a template DIR and render its DAG preview. Throws (loudly) if the template does not
 * compile — `loadTemplate` carries every §8 violation, so a malformed template fails here in ms, free.
 */
export async function extractTemplate(dir: string): Promise<string> {
  const spec = await loadTemplate(dir);
  const wf = compile(spec);
  return renderDag(wf);
}

/** `piflowctl extract <templateDir>` — print the free DAG preview. Required positional: the template dir. */
export async function runExtractCli(argv: string[]): Promise<void> {
  const dir = argv.find((a) => !a.startsWith('-'));
  if (!dir) {
    process.stderr.write('piflowctl extract: a template directory is required (piflowctl extract <templateDir>)\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write((await extractTemplate(dir)) + '\n');
}

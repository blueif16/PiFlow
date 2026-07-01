// `piflowctl optimize <rundir> [--json] [--archetype <name>]` — the out-of-band Score + Triage accessor
// (piflow-memory-v1.5 §7). A THIN renderer over the shared optimize layer (`@piflow/core` scoreRun / triage
// / renderRouting): it reads a FINISHED run's `.pi` trace + the product's recorded verify reports, folds the
// two deterministic tiers into a per-node score, projects the four-way worklist, and prints it.
//
// It LANDS NOTHING — read-only, post-run, off the critical path. This is the diagnosis surface the fixer
// (a later phase) consumes; the worklist it prints is the automated HERMES-ROUTING.md.
//
//   default   → the rendered routing markdown (the proven hermes-routing.md shape) on stdout.
//   --json    → the raw { scores, defects } worklist for an agent/driver to consume directly.

import path from 'node:path';
import { scoreRun, triage, deriveRecurrence, renderRouting, type NodeScore, type Defect } from '@piflow/core';

export interface ParsedOptimizeArgs {
  dir: string;
  json: boolean;
  archetype?: string;
}

export function parseOptimizeArgs(argv: string[]): ParsedOptimizeArgs {
  const out: ParsedOptimizeArgs = { dir: '', json: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') out.json = true;
    else if (k === '--archetype') out.archetype = argv[++i];
    else if (k.startsWith('--')) { /* ignore unknown flags — this is a read-only accessor */ }
    else positionals.push(k);
  }
  out.dir = positionals[0] ?? '';
  return out;
}

export async function runOptimizeCli(argv: string[]): Promise<void> {
  const args = parseOptimizeArgs(argv);
  if (!args.dir) {
    process.stderr.write('piflowctl optimize: a <rundir> is required (the finished run dir to score).\n');
    process.exitCode = 2;
    return;
  }

  const { scores, digest } = await scoreRun(args.dir);
  // Leg-A recurrence (the SKILL signal): resolve the product template from the run dir
  // (.piflow/<wf>/runs/<id> → …/template) and read its per-node memory.md. deriveRecurrence degrades to an
  // empty index (⇒ pure LAPSE, today's behavior) if the path/memory is absent, so a non-canonical dir can't crash.
  const templateDir = path.resolve(args.dir, '..', '..', 'template');
  const recurrence = deriveRecurrence({ templateDir, nodes: scores.map((s) => s.node) });
  const defects = triage(scores, digest, { recurrence });

  if (args.json) {
    process.stdout.write(JSON.stringify({ run: digest.run, scores, defects } satisfies { run: string; scores: NodeScore[]; defects: Defect[] }, null, 2) + '\n');
    return;
  }

  const runId = digest.run || args.dir;
  process.stdout.write(renderRouting(defects, { runId, ...(args.archetype ? { archetype: args.archetype } : {}) }) + '\n');
  // a one-line summary to stderr so a human sees the count without parsing the markdown.
  process.stderr.write(`\noptimize: ${defects.length} defect(s) across ${scores.length} node(s) in ${runId} (read-only; nothing landed).\n`);
}

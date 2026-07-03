// `piflowctl optimize <rundir> [--json] [--archetype <name>]` — the out-of-band Score + Triage accessor
// (piflow-memory-v1.5 §7). A THIN renderer over the shared optimize layer (`@piflow/core` scoreRun / triage
// / renderRouting): it reads a FINISHED run's `.pi` trace + the product's recorded verify reports, folds the
// two deterministic tiers into a per-node score, projects the four-way worklist, and prints it.
//
// It LANDS NOTHING IN THE PRODUCT — read-only over the product's code, post-run, off the critical path (never
// stages/adopts a fix; that is `--fix`'s job). It DOES persist its own diagnosis: every invocation writes the
// worklist to `<rundir>/.pi/optimize.json` (idempotent — overwrite, never append) so the recorded basis a later
// optimize/fix pass (or a human) reads survives the process, instead of existing only in the printed output an
// operator would otherwise have to redirect `--json` by hand to capture.
//
//   default   → the rendered routing markdown (the proven hermes-routing.md shape) on stdout.
//   --json    → the raw { scores, defects } worklist for an agent/driver to consume directly.
//   (always)  → `<rundir>/.pi/optimize.json`, the SAME payload the `--json` mode prints.

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { scoreRun as coreScoreRun, triage, deriveRecurrence, memorize, renderRouting, type NodeScore, type Defect, type RunDigest } from '@piflow/core';

export interface ParsedOptimizeArgs {
  dir: string;
  json: boolean;
  archetype?: string;
  /** persist the run's tier0-signature defects into Leg-A memory.md (the MEMORIZE writer). Off by default. */
  memorize: boolean;
}

export function parseOptimizeArgs(argv: string[]): ParsedOptimizeArgs {
  const out: ParsedOptimizeArgs = { dir: '', json: false, memorize: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') out.json = true;
    else if (k === '--memorize') out.memorize = true;
    else if (k === '--archetype') out.archetype = argv[++i];
    else if (k.startsWith('--')) { /* ignore unknown flags — this is a read-only accessor */ }
    else positionals.push(k);
  }
  out.dir = positionals[0] ?? '';
  return out;
}

export interface OptimizeCliDeps {
  /** inject the score pass (the trace read) — default `@piflow/core` scoreRun. Testable without a live trace. */
  scoreRun?: (dir: string) => Promise<{ scores: NodeScore[]; digest: RunDigest }>;
}

/** The `--json` payload shape — ALSO what `.pi/optimize.json` persists, byte-for-byte (one source of truth). */
type OptimizeWorklist = { run: string; scores: NodeScore[]; defects: Defect[] };

export async function runOptimizeCli(argv: string[], deps: OptimizeCliDeps = {}): Promise<void> {
  const args = parseOptimizeArgs(argv);
  if (!args.dir) {
    process.stderr.write('piflowctl optimize: a <rundir> is required (the finished run dir to score).\n');
    process.exitCode = 2;
    return;
  }

  const { scores, digest } = await (deps.scoreRun ?? coreScoreRun)(args.dir);
  // Leg-A recurrence (the SKILL signal): resolve the product template from the run dir
  // (.piflow/<wf>/runs/<id> → …/template) and read its per-node memory.md. deriveRecurrence degrades to an
  // empty index (⇒ pure LAPSE, today's behavior) if the path/memory is absent, so a non-canonical dir can't crash.
  const templateDir = path.resolve(args.dir, '..', '..', 'template');
  const recurrence = deriveRecurrence({ templateDir, nodes: scores.map((s) => s.node) });
  const defects = triage(scores, digest, { recurrence });

  // The MEMORIZE writer (opt-in, --memorize): persist the run's tier0-signature defects into Leg-A memory.md so
  // the two-run recurrence carry needs no human hand-write. The count is DERIVED from the run trail (idempotent);
  // the shipped reader is unchanged. Off by default — the read-only accessor behavior is preserved.
  if (args.memorize) {
    const { lessons } = memorize(scores, defects, { runDir: args.dir, templateDir });
    const appended = lessons.filter((l) => l.action === 'append').length;
    const updated = lessons.filter((l) => l.action === 'update').length;
    process.stderr.write(`memorized: ${lessons.length} lesson(s) — ${appended} appended, ${updated} updated\n`);
  }

  const worklist: OptimizeWorklist = { run: digest.run, scores, defects };

  // PERSIST — the durable diagnosis artifact this pass now leaves behind, unconditionally and idempotently
  // (a fresh full overwrite every run, never an append), regardless of --json. Before this, `optimize` was
  // pure stdout — nothing survived the process, so a later pass (or a human) had no recorded basis to read
  // without redirecting `--json` by hand. This writes PRODUCT-scoped data (the run's OWN `.pi/`, inside the
  // per-product repo) — never into the SDK — matching the run-layout convention every other run artifact uses.
  const optimizeJsonPath = path.join(args.dir, '.pi', 'optimize.json');
  await fs.mkdir(path.dirname(optimizeJsonPath), { recursive: true });
  await fs.writeFile(optimizeJsonPath, JSON.stringify(worklist, null, 2) + '\n', 'utf8');

  if (args.json) {
    process.stdout.write(JSON.stringify(worklist, null, 2) + '\n');
    return;
  }

  const runId = digest.run || args.dir;
  process.stdout.write(renderRouting(defects, { runId, ...(args.archetype ? { archetype: args.archetype } : {}) }) + '\n');
  // a one-line summary to stderr so a human sees the count without parsing the markdown.
  process.stderr.write(`\noptimize: ${defects.length} defect(s) across ${scores.length} node(s) in ${runId} (read-only over the product; ${optimizeJsonPath} written; nothing landed).\n`);
}

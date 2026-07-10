// optimize/blame/paths.ts — the ONE place that names every path under a run's blame dir
// (docs/design/optimize-blame.md §1.2/§3). The blame dir LAW:
//   - Blame artifacts are PER-RUN DISPATCH artifacts: born under `<runDir>/optimize/blame/`, born archived,
//     immutable, no relocation step ever (§1.2 decision 2). They are NOT lifecycle objects — no status
//     machine, no `sig`/dedup, no reopen; a blame file is consumed and superseded by the NEXT run's blame.
//   - Per-node blame files (`<node>.md`) are PROSE, NEVER machine-parsed. Their only consumers are the
//     node's triage agent (verbatim inject) and a human — nothing in the codebase reads them structurally
//     (§3, §9). A `dissent.<node>.md` is the node-triage seam's contest trace (§4.1), same law: prose, not
//     schema.
//   - The run SUMMARY (`blame.md`) is the ONE parser boundary: prose ending in a small fenced JSON tail
//     (`{blamed, edges, unattributed}`) — the ONLY machine-read surface in the whole `blame/` dir (§3). The
//     scheduler (§5) and lane priority read ONLY that tail; nothing else in `blame/` is ever JSON.parse'd
//     except `measure.json`, which is the mechanical (non-prose) hard-measure report (§2/§4 step 1, this
//     module's WS-B1 twin).
import path from 'node:path';

/** `<runDir>/optimize/blame` — the per-run blame dir root. */
export function blameDir(runDir: string): string {
  return path.join(runDir, 'optimize', 'blame');
}

/** `<runDir>/optimize/blame/<node>.md` — one node's prose blame file. NEVER machine-parsed. */
export function blameFilePath(runDir: string, node: string): string {
  return path.join(blameDir(runDir), `${node}.md`);
}

/** `<runDir>/optimize/blame/blame.md` — the run-level prose summary + fenced-tail. THE parser boundary. */
export function blameSummaryPath(runDir: string): string {
  return path.join(blameDir(runDir), 'blame.md');
}

/** `<runDir>/optimize/blame/measure.json` — the run-level hard measure fold (this module, WS-B1). */
export function blameMeasurePath(runDir: string): string {
  return path.join(blameDir(runDir), 'measure.json');
}

/** `<runDir>/optimize/blame/dissent.<node>.md` — a node-triage contest of an attribution (§4.1). Prose. */
export function blameDissentPath(runDir: string, node: string): string {
  return path.join(blameDir(runDir), `dissent.${node}.md`);
}

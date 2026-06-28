// Stage-window selection (run.mjs selectStages 600–635) — the `--from/--until` resume window math.
// Extracted verbatim from runner.ts (the §2.1 cluster D split); re-exported there for the run loop.

import type { Workflow, Stage } from '../types.js';

function stageMatches(stage: Stage, wf: Workflow, needle: string): boolean {
  const q = needle.toLowerCase();
  if ((stage.phase ?? '').toLowerCase().includes(q)) return true;
  return stage.nodeIds.some((id) => {
    const n = wf.nodes[id];
    return id.toLowerCase().includes(q) || (n?.label ?? '').toLowerCase().includes(q);
  });
}

export function selectWindow(wf: Workflow, from?: string, until?: string): { fromIdx: number; untilIdx: number } {
  const stages = wf.stages;
  let fromIdx = 0;
  let untilIdx = stages.length - 1;
  if (from) {
    const i = stages.findIndex((s) => stageMatches(s, wf, from));
    if (i >= 0) fromIdx = i;
  }
  if (until) {
    let last = -1;
    stages.forEach((s, i) => { if (stageMatches(s, wf, until)) last = i; });
    if (last >= 0) untilIdx = last;
  }
  if (fromIdx > untilIdx) fromIdx = 0; // a from-after-until is incoherent → ignore from
  return { fromIdx, untilIdx };
}

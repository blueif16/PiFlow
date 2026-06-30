// optimize/mine.ts — the default trace task-miner (piflow-memory-v1.5 §5.1: "mine a checkable task from a
// node's run trace"). The MINING half of the replay binding; makeReplayStages (replay.ts) is the FOLDING half.
//
// Mirrors score.ts's established boundary pattern: a PRODUCT-AGNOSTIC mechanism with a game-omni DEFAULT
// config, injectable. The miner reads the incumbent's recorded report from the trace — the SAME
// `verify/report.M{k}.json` layout score.ts's readRecordedVerifyReports already owns — and emits a
// CheckableTask. It does NOT import game-omni code: oracleInput carries only { milestoneId }; the live oracle
// re-reads blueprint + assertions from the candidate copy, so no blueprint-path knowledge accretes into core.
//
// SYNC by contract — the driver's baseScore (and thus mineTask) is synchronous; an out-of-band post-run tool
// reads the trace synchronously (readFileSync). The `split` tag this miner stamps is what the gate's
// VAL-hygiene keys on (replay.ts requireVal); other products inject `nodeToMilestone`/`split` of their own.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MineTask, CheckableTask } from './replay.js';

export interface MineOpts {
  /** node id → the milestone id it produced (e.g. "w4-execute-m2" → "M2"). Default: game-omni's convention. */
  nodeToMilestone?: (node: string) => string | null;
  /** held-out 'val' vs 'train' classifier. Default: 'val' (game-omni's prompt-suites are held-out by convention). */
  split?: (task: { node: string; milestoneId: string }) => 'val' | 'train';
}

/** game-omni: node "w4-execute-m2" produces milestone "M2". The INVERSE of score.ts gameOmniMilestoneToNode. */
export function gameOmniNodeToMilestone(node: string): string | null {
  const k = /^w4-execute-m(\d+)$/.exec(node);
  return k ? `M${k[1]}` : null;
}

/** Read + parse a JSON file; null on missing/malformed (a node with no recorded report is "nothing to replay"). */
function readJsonOrNull(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build a MineTask bound to a finished run dir: node → the CheckableTask the replay harness scores, or null
 * (no milestone maps to the node, or no incumbent report was recorded). The baseReport is the PARSED recorded
 * report; oracleInput is the minimal { milestoneId } the live oracle needs to re-verify a candidate.
 */
export function mineTaskFromTrace(runDir: string, opts: MineOpts = {}): MineTask {
  const nodeToMilestone = opts.nodeToMilestone ?? gameOmniNodeToMilestone;
  const classify = opts.split ?? ((): 'val' => 'val');
  const runId = path.basename(runDir);
  return (node) => {
    const milestoneId = nodeToMilestone(node);
    if (!milestoneId) return null;
    const baseReport = readJsonOrNull(path.join(runDir, 'verify', `report.${milestoneId}.json`));
    if (baseReport == null) return null; // no recorded incumbent → nothing to gate a candidate against
    return {
      id: `${runId}:${milestoneId}`,
      node,
      split: classify({ node, milestoneId }),
      baseReport,
      oracleInput: { milestoneId },
    } satisfies CheckableTask;
  };
}

// optimize/score.ts — the out-of-band SCORE pass (v1.5 §7). Folds the two DETERMINISTIC tiers into a
// per-node score the gate/triage key on:
//   Tier-0 (telemetry, observe/telemetry.ts projectRunDigest) — the judgment-free structural DISQUALIFIER
//           (failure / truncation / tool-loop). A pre-filter, NEVER a quality grade.
//   Tier-1 (the product's outcome/checkable signal, e.g. game-omni's verify-milestone report via tier1.ts) —
//           the preferred QUALITY value the accept gate keys on.
// Tier-2 (judgment) is deliberately ABSENT in v1 — quarantined out of the verdict (v1.5 §4c).
//
// The module splits a PURE fold (`scoreNodes`, unit-tested) from a thin IMPURE shell (`scoreRun`, reads the
// run dir + the recorded verify reports). The Tier-1 source is INJECTABLE so the SAME fold serves both the
// MVP (read recorded reports) and the later GATE step (re-run runMilestoneVerify2 on a candidate edit).
//
// LOAD-BEARING RULES (pinned by optimize-score.test.ts):
//   • ABSTAIN ≠ low score — a Tier-1 that could-not-measure yields scalar=null + abstained, never 0.
//   • A Tier-0 disqualifier OVERRIDES a Tier-1 abstain — a real structural failure scores 0, not abstain.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AnomalyKind, RunDigest } from '../observe/telemetry.js';
import { projectRunDigest } from '../observe/telemetry.js';
import { buildRunView } from '../observe/runView.js';
import type { NodeScore, Tier0Signal, Tier1Result } from './types.js';
import { readVerifyReport } from './tier1.js';

/** The Tier-0 anomaly kinds that are STRUCTURAL disqualifiers (vs the soft risk signals slow/retries/context). */
const DISQUALIFIERS = new Set<AnomalyKind>(['failed', 'truncated', 'tool-loop']);

export interface ScoreInput {
  digest: RunDigest;
  /** Tier-1 verdict per producing node (a milestone-verify mapped onto the node that produced its build). */
  tier1ByNode: Map<string, Tier1Result>;
}

/** PURE: fold (Tier-0 disqualifier × Tier-1 value) → one NodeScore per node in the digest. */
export function scoreNodes(input: ScoreInput): NodeScore[] {
  return input.digest.nodes.map((n): NodeScore => {
    const disq = n.anomalies.filter((a) => DISQUALIFIERS.has(a));
    const tier0: Tier0Signal = { anomalies: n.anomalies, disqualified: disq.length > 0, ...(disq.length ? { reason: disq[0] } : {}) };
    const tier1 = input.tier1ByNode.get(n.id) ?? null;
    // abstain only when there was a Tier-1 that could-not-measure AND no real structural disqualifier.
    const abstained = !!tier1 && tier1.abstained && !tier0.disqualified;
    const scalar: number | null = abstained ? null : tier0.disqualified ? 0 : tier1 ? tier1.scalar : null;
    return { node: n.id, tier0, tier1, scalar, abstained };
  });
}

// ── the impure shell ──────────────────────────────────────────────────────────────────────────────────
export interface ScoreRunOpts {
  /**
   * Map a verify milestone id (e.g. "M2") → the producing node id (e.g. "w4-execute-m2"). PRODUCT-SPECIFIC;
   * the default is game-omni's convention (Mk → w4-execute-m{k}). Other products inject their own.
   */
  milestoneToNode?: (milestoneId: string) => string | null;
  /** Override the Tier-1 source (e.g. live runMilestoneVerify2 for the GATE). Default: read recorded reports. */
  tier1Source?: (runDir: string) => Promise<Map<string, Tier1Result>>;
}

/** game-omni's convention: milestone "M2" is produced by node "w4-execute-m2". */
const gameOmniMilestoneToNode = (m: string): string | null => {
  const k = /^M(\d+)$/.exec(m);
  return k ? `w4-execute-m${k[1]}` : null;
};

/** Read `<runDir>/verify/report.*.json` → Tier1Result per producing node (the MVP recorded-outcome source). */
async function readRecordedVerifyReports(runDir: string, milestoneToNode: (m: string) => string | null): Promise<Map<string, Tier1Result>> {
  const out = new Map<string, Tier1Result>();
  const verifyDir = path.join(runDir, 'verify');
  let files: string[] = [];
  try {
    files = (await fs.readdir(verifyDir)).filter((f) => /^report\.M\d+\.json$/.test(f));
  } catch {
    return out; // no verify dir → no Tier-1 (the scorer still runs on Tier-0 alone)
  }
  for (const f of files) {
    const p = path.join(verifyDir, f);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(p, 'utf8'));
    } catch {
      continue; // a malformed report contributes no Tier-1 (never throws the whole pass)
    }
    const t1 = readVerifyReport(parsed, { reportPath: p });
    const node = milestoneToNode(t1.milestoneId);
    if (node) out.set(node, t1);
  }
  return out;
}

/**
 * IMPURE: score a finished run dir. Builds the Tier-0 digest from `.pi` + maps the recorded verify reports
 * onto producing nodes, then folds. Read-only — writes nothing. Returns the digest too (triage consumes it).
 */
export async function scoreRun(runDir: string, opts: ScoreRunOpts = {}): Promise<{ scores: NodeScore[]; digest: RunDigest }> {
  const milestoneToNode = opts.milestoneToNode ?? gameOmniMilestoneToNode;
  const { view } = buildRunView(runDir);
  const digest = projectRunDigest(view);
  const tier1ByNode = await (opts.tier1Source ? opts.tier1Source(runDir) : readRecordedVerifyReports(runDir, milestoneToNode));
  return { scores: scoreNodes({ digest, tier1ByNode }), digest };
}

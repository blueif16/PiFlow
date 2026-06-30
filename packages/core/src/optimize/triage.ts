// optimize/triage.ts — the four-way credit-assignment projector (v1.5 §3, §7). Turns the SCORE pass'
// NodeScore[] + the run digest into the worklist a fixer consumes (= the automated HERMES-ROUTING.md). It
// assigns each defect to ONE of four buckets — {LAPSE, SKILL, FUNCTIONALITY, ARCH} — ordered by ascending
// blast radius, deciding from OBSERVABLE signals only and defaulting toward the lowest blast radius (LAPSE)
// when unsure (the corpus-protection rule). Buckets it cannot yet decide NAME the missing signal in
// `needsSignal` rather than mis-attributing.
//
// What the MVP can decide deterministically (and what it defers):
//   • ARCH          ← a cross-node failure chain: the failure ORIGINATED upstream (digest.rootCauses, shipped).
//   • FUNCTIONALITY ← a clean-completing node whose Tier-1 OUTCOME failed = the product code is wrong. For
//                     game-omni the verify-milestone report IS the "product-test-as-node-outcome" v1.5 §7
//                     said FUNCTIONALITY needs — so it is decidable now, NOT defaulted to LAPSE.
//   • LAPSE         ← a self-originating structural failure with no code signal: the default-when-unsure.
//   • SKILL         ← needs cross-run recurrence (the first reader of Leg-A memory.md) — DEFERRED; until that
//                     signal exists, a residual is LAPSE + a `needsSignal` pointing at recurrence/prose-judge.
//
// The projector writes NOTHING and invents NO prose — the deep free-text root-cause trace the human used to
// hand-write is the FIXER's job. This emits pointers (failing check ids, the upstream chain), never a story.

import type { RunDigest, RootCause } from '../observe/telemetry.js';
import type { NodeScore, Defect, Confidence, CriteriaFixture, Tier1Result } from './types.js';

export interface TriageOpts {
  /** the product's per-node quality bar (informs a future SKILL/prose-judge; unused by the MVP buckets). */
  criteria?: CriteriaFixture;
  // priorRuns + Leg-A memory.md (the cross-run recurrence signal for SKILL) land here in a later phase.
}

/** A Tier-1 outcome that MEASURED and FAILED (abstain is not a failure). */
const tier1Failed = (s: NodeScore): boolean => !!s.tier1 && !s.tier1.abstained && !s.tier1.passed;

/** A node earns a worklist item iff it has a real problem signal — and abstained nodes never do (re-measure). */
const isDefect = (s: NodeScore): boolean => !s.abstained && (s.tier0.disqualified || tier1Failed(s));

export function triage(scores: NodeScore[], digest: RunDigest, _opts: TriageOpts = {}): Defect[] {
  const rootCauseOf = new Map(digest.rootCauses.map((rc) => [rc.failed, rc]));
  const defects: Defect[] = [];
  for (const s of scores) {
    if (!isDefect(s)) continue;
    const rc = rootCauseOf.get(s.node);
    if (rc && rc.earliestUpstream !== rc.failed) {
      defects.push(archDefect(s, rc));
    } else if (tier1Failed(s) && !s.tier0.disqualified) {
      defects.push(functionalityDefect(s, s.tier1!));
    } else {
      defects.push(lapseDefect(s));
    }
  }
  return defects;
}

// ── ④ ARCH — the failure originated upstream; route UP to reconcile ─────────────────────────────────────
function archDefect(s: NodeScore, rc: RootCause): Defect {
  return {
    node: s.node,
    bucket: 'ARCH',
    symptom: `failure originates upstream at ${rc.earliestUpstream} → ${rc.failed}${rc.viaPath ? ` (via ${rc.viaPath})` : ''}`,
    evidence: [`chain:${rc.chain.join(' → ')}`, ...(rc.viaPath ? [`via:${rc.viaPath}`] : [])],
    confidence: 'medium',
  };
}

// ── ③ FUNCTIONALITY — a clean node whose checkable outcome failed; the product code is wrong ─────────────
function functionalityDefect(s: NodeScore, t1: Tier1Result): Defect {
  const failed = t1.checks.filter((c) => !c.passed);
  const first = failed[0];
  // a failed fidelity/completability check is a checkable RUNTIME outcome ⇒ high confidence the code is wrong.
  const checkable = failed.some((c) => c.gate === 'fidelity' || c.gate === 'completability');
  const confidence: Confidence = checkable ? 'high' : 'medium';
  const symptom = first
    ? `${t1.milestoneId}: ${failed.length}/${t1.checks.length} checks failed — ${first.id}${first.message ? ` (${first.message})` : ''}`
    : `${t1.milestoneId}: verify FAILED (${t1.marker})`;
  return {
    node: s.node,
    bucket: 'FUNCTIONALITY',
    symptom,
    evidence: [
      ...failed.map((c) => `check:${c.id}`),
      `fix-surface: product code in ${s.node}'s owns/readScope (owner traced by the fixer)`,
    ],
    confidence,
  };
}

// ── ① LAPSE — self-originating structural failure, no code signal: the default-when-unsure ──────────────
function lapseDefect(s: NodeScore): Defect {
  return {
    node: s.node,
    bucket: 'LAPSE',
    symptom: `${s.node} ${s.tier0.reason ?? 'underperformed'} with no code-level signal`,
    evidence: [`anomalies:${s.tier0.anomalies.join(',') || 'none'}`],
    confidence: 'low',
    needsSignal: 'cross-run recurrence (Leg-A memory.md) to confirm SKILL, or a prose-judge of the node skill',
  };
}

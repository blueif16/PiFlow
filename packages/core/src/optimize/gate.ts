// optimize/gate.ts — the across-run ACCEPT gate (v1.5 §2, §6). This is the curation gate that keeps a
// self-editing loop from drifting: Library-Drift measured autonomous self-editing at +0.0pp WITHOUT it.
// It is PURE arithmetic over model-produced scores — "the model PROPOSES + SCORES; deterministic code
// DECIDES" (SkillOpt gate.py:43-50). The loop NEVER mutates the live file; the gate only renders a verdict.
//
// The invariants (verbatim from SkillOpt's working skillopt_sleep, v1.5 §6):
//   • accept = "≥1 edit applied AND candidate > base" — STRICT improvement (consolidate.py:222). This, not
//     the round count, is what stops drift.
//   • FUNCTIONALITY carries a STRICTER gate (v1.5 §3 ③): a code edit's higher blast radius ⇒ the product's
//     OWN build/tests/typecheck must ALSO pass — a score bump alone is not enough.
//   • NEVER judge-gated accept (v1.5 §4c): an unmeasurable/abstained score cannot auto-accept; route to the
//     human.
//   • per-target LAND policy: ARCH (structural) always takes the heavyweight human gate (v1.5 §3 ④);
//     outcome-gated buckets are auto-adopt-ELIGIBLE (the driver still consults the global auto_adopt flag,
//     default OFF, before actually committing).

import type { DefectBucket } from './types.js';

export type LandPolicy = 'auto-adopt-eligible' | 'stage-for-human';

export interface GateInput {
  bucket: DefectBucket;
  /** the incumbent score on the held-out VAL slice (null = abstained/unmeasurable). */
  base: number | null;
  /** the candidate edit's score on the SAME val slice (null = abstained/unmeasurable). */
  candidate: number | null;
  /** how many edits the fixer actually applied to the candidate copy (0 = a no-op proposal). */
  editsApplied: number;
  /** FUNCTIONALITY only: did the candidate pass the product's own build/tests/typecheck? */
  candidatePassedProductChecks?: boolean;
}

export interface GateVerdict {
  accept: boolean;
  reason: string;
  /** candidate − base when both are measurable; null otherwise. */
  delta: number | null;
  landPolicy: LandPolicy;
}

/** PURE: render the accept/reject verdict + the per-target land policy. Decides nothing about disk. */
export function evaluateGate(i: GateInput): GateVerdict {
  // ARCH is structural — always the heavyweight human gate, regardless of the score (v1.5 §3 ④).
  const landPolicy: LandPolicy = i.bucket === 'ARCH' ? 'stage-for-human' : 'auto-adopt-eligible';
  const delta = i.base != null && i.candidate != null ? i.candidate - i.base : null;

  if (i.editsApplied < 1) return { accept: false, reason: 'no edit applied', delta, landPolicy };

  // NEVER judge-gated: if either side could not be measured, the gate cannot accept — route to the human.
  if (i.base == null || i.candidate == null)
    return { accept: false, reason: 'score unmeasurable/abstained — cannot outcome-gate; route to human', delta, landPolicy: 'stage-for-human' };

  // FUNCTIONALITY's stricter gate: the product's own build/tests must pass (higher blast radius ⇒ harder gate).
  if (i.bucket === 'FUNCTIONALITY' && i.candidatePassedProductChecks !== true)
    return { accept: false, reason: 'FUNCTIONALITY candidate failed the product build/tests (stricter gate)', delta, landPolicy };

  // the load-bearing rule: STRICT improvement only.
  if (!(i.candidate > i.base))
    return { accept: false, reason: `no strict improvement (candidate ${i.candidate} ≤ base ${i.base})`, delta, landPolicy };

  return { accept: true, reason: `strict improvement (+${delta})`, delta, landPolicy };
}

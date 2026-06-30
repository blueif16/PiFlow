// optimize/driver.ts — the FIX→GATE overlord (v1.5 §6). A DETERMINISTIC, straight-line driver: it COMPOSES
// the bounded model stages (the context-isolated fixer; the held-out replay scorer) but the control flow,
// the gate decision, the caps, and the land policy are all CODE. "The model PROPOSES + SCORES; deterministic
// code DECIDES, BOUNDS, and LANDS — and the loop NEVER mutates the live file" (SkillOpt cycle.py:90).
//
// The fixer writes to a candidate COPY ref (prepareCandidate), the scorer reads the copy, the gate compares
// candidate vs base on the held-out VAL slice, and the driver RECORDS a decision (adopted | staged |
// discarded). The PHYSICAL landing (stage to a dir / adopt = backup-then-overwrite the live file) is land.ts,
// driven from this manifest — so this module touches no live file. Bounds: a per-round edit_budget (the
// "learning rate" — caps the expensive fixer attempts), a cumulative token budget, and the rejected-edit
// buffer (never re-propose a dead edit). Single-candidate; multi-candidate Pareto is v1.5 §6 phase-2.

import type { Defect, DefectBucket } from './types.js';
import { evaluateGate, type GateVerdict } from './gate.js';

/** What a context-isolated fixer reports after editing the candidate copy. It PROPOSES; it never lands. */
export interface CandidateEdit {
  /** edits actually applied to the candidate copy (0 = a no-op proposal; the gate rejects it). */
  editsApplied: number;
  /** FUNCTIONALITY: did the candidate pass the product's own build/tests/typecheck? (the stricter gate). */
  candidatePassedProductChecks?: boolean;
  tokensSpent?: number;
  summary?: string;
}

/** The injected fixer stage — context-isolated; edits the candidate COPY at ctx.candidateRef. */
export type Fixer = (defect: Defect, ctx: { candidateRef: string }) => Promise<CandidateEdit>;
/** The injected scorer — re-scores the candidate on the held-out VAL slice (null = abstained/unmeasurable). */
export type ReplayScore = (node: string, candidateRef: string) => Promise<number | null>;
/** Make a candidate COPY for this defect and return its ref (NEVER the live path). */
export type PrepareCandidate = (defect: Defect) => Promise<string>;
/** The incumbent score on the held-out VAL slice (null = abstained). */
export type BaseScore = (node: string) => number | null;

export interface FixGateStages {
  fixer: Fixer;
  replayScore: ReplayScore;
  prepareCandidate: PrepareCandidate;
  baseScore: BaseScore;
}

export interface FixGateOpts {
  /** max fixer ATTEMPTS this round — the "learning rate"/cost bound (SkillOpt = 4). Default 4. */
  editBudget?: number;
  /** optional cumulative token cap; the driver stops before an attempt once it is reached. */
  tokenBudget?: number;
  /** default OFF: an auto-adopt-ELIGIBLE win still STAGES unless this is set (v1.5 §6). */
  autoAdopt?: boolean;
  /** dead-edit keys — skipped (never re-proposed) and added to on reject. Mutated in place. */
  rejectedBuffer?: Set<string>;
}

export interface FixGateRecord {
  node: string;
  bucket: DefectBucket;
  /** the candidate copy ref the fixer edited (proof the edit never touched live). */
  candidateRef: string;
  editsApplied: number;
  verdict: GateVerdict;
  /** the DECISION (land.ts applies it): adopt the copy, stage it for the human, or discard it. */
  landed: 'adopted' | 'staged' | 'discarded';
  tokensSpent: number;
}

export interface FixGateResult {
  records: FixGateRecord[];
  attempted: number;
  accepted: number;
  stoppedReason: 'complete' | 'edit-budget' | 'token-budget';
}

/** A stable key for the rejected-edit buffer — the defect's node + bucket + symptom. */
const defectKey = (d: Defect): string => `${d.node}::${d.bucket}::${d.symptom}`;

/**
 * Run one FIX→GATE round over the worklist. Returns the manifest of decisions; lands nothing physically.
 * The model is confined to the injected fixer/replayScore; everything else here is deterministic.
 */
export async function runFixGate(defects: Defect[], stages: FixGateStages, opts: FixGateOpts = {}): Promise<FixGateResult> {
  const editBudget = opts.editBudget ?? 4;
  const buffer = opts.rejectedBuffer ?? new Set<string>();
  const records: FixGateRecord[] = [];
  let attempted = 0;
  let accepted = 0;
  let tokens = 0;
  let stoppedReason: FixGateResult['stoppedReason'] = 'complete';

  for (const d of defects) {
    if (buffer.has(defectKey(d))) continue; // dead edit — don't re-propose
    if (attempted >= editBudget) { stoppedReason = 'edit-budget'; break; }
    if (opts.tokenBudget != null && tokens >= opts.tokenBudget) { stoppedReason = 'token-budget'; break; }

    // PROPOSE on a candidate COPY — never the live file.
    const candidateRef = await stages.prepareCandidate(d);
    const edit = await stages.fixer(d, { candidateRef });
    attempted++;
    tokens += edit.tokensSpent ?? 0;

    // SCORE the candidate on the held-out VAL slice, then GATE (pure arithmetic).
    const candidate = await stages.replayScore(d.node, candidateRef);
    const verdict = evaluateGate({
      bucket: d.bucket,
      base: stages.baseScore(d.node),
      candidate,
      editsApplied: edit.editsApplied,
      ...(edit.candidatePassedProductChecks !== undefined ? { candidatePassedProductChecks: edit.candidatePassedProductChecks } : {}),
    });

    // DECIDE the landing (land.ts applies it physically): adopt iff accepted AND eligible AND the flag is set.
    let landed: FixGateRecord['landed'];
    if (!verdict.accept) {
      landed = 'discarded';
      buffer.add(defectKey(d)); // remember the dead edit
    } else if (verdict.landPolicy === 'auto-adopt-eligible' && opts.autoAdopt) {
      landed = 'adopted';
      accepted++;
    } else {
      landed = 'staged';
      accepted++;
    }

    records.push({ node: d.node, bucket: d.bucket, candidateRef, editsApplied: edit.editsApplied, verdict, landed, tokensSpent: edit.tokensSpent ?? 0 });
  }

  return { records, attempted, accepted, stoppedReason };
}

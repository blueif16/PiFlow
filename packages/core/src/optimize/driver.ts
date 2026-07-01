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
import type { OptimizeEventSink } from './events.js';

/** What a context-isolated fixer reports after editing the candidate copy. It PROPOSES; it never lands. */
export interface CandidateEdit {
  /** edits actually applied to the candidate copy (0 = a no-op proposal; the gate rejects it). */
  editsApplied: number;
  /** FUNCTIONALITY: did the candidate pass the product's own build/tests/typecheck? (the stricter gate). */
  candidatePassedProductChecks?: boolean;
  tokensSpent?: number;
  summary?: string;
  /**
   * The fixer's traced ROOT CAUSE — a passive string the driver copies edit→record with ZERO interpretation
   * (core never reads or parses it). It feeds the DISTILLER at the CLI seam (distillLesson): the raw material the
   * model condenses into a lesson's Root/Prevention prose. Optional — a fixer that traces none omits it, and the
   * driver leaves the record's `foundRoot` key absent (records stay byte-identical when unused).
   */
  foundRoot?: string;
  /**
   * Set when the fixer was CUT SHORT (a watchdog trip or a wall-clock timeout) rather than finishing on its own.
   * Product-agnostic SHAPE, product-specific `reason` STRING — the driver surfaces it as a first-class
   * `fixer-aborted` OptimizeEvent so the control plane keys on the cutoff PORTABLY (it reads this TYPED return,
   * never the opaque `emit` payload). An aborted fixer is still just a proposal (usually 0 edits) the gate judges.
   */
  aborted?: { reason: string };
}

/**
 * The injected fixer stage — context-isolated; edits the candidate COPY at ctx.candidateRef. `ctx.emit` is an
 * OPAQUE sub-trace channel: the fixer may surface progress crumbs through it and the driver re-emits them as
 * `fixer-trace` events verbatim (core never inspects the payload). It is optional so a fixer can ignore it.
 */
export type Fixer = (defect: Defect, ctx: { candidateRef: string; emit?: (payload: Record<string, unknown>) => void }) => Promise<CandidateEdit>;
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
  /**
   * OPTIONAL, product-side counter reads — how many failed fix cycles this node has ALREADY consumed (across
   * `optimize --fix` invocations). Backs the deterministic fix-cycle CEILING. @piflow/core NEVER persists this
   * (boundary law: the SDK is logic only) — the product injects a file-backed reader. The ceiling activates
   * ONLY when this + bumpFixCycles + opts.fixCycleCeiling are ALL present, so a binding without them is 100%
   * backward-compatible.
   */
  readFixCycles?: (node: string) => number;
  /** OPTIONAL, product-side counter writer — increment this node's failed-fix-cycle count. Called by the driver
   * ONLY after a REAL failed fix (a rejected verdict with >=1 edit applied); an accept / 0-edit / aborted
   * proposal does NOT consume budget. Core mutates NO file — this injected fn is the ONLY writer. */
  bumpFixCycles?: (node: string) => void;
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
  /**
   * OPTIONAL per-node re-attempt CEILING (v1.5 deferred-driver bound): once a node has consumed this many
   * failed fix cycles it is SKIPPED (not re-attempted) and surfaced on result.skipped + a fix-cycle-ceiling
   * event, so a structurally-unfixable node ESCALATES instead of looping across invocations. Active ONLY when
   * this AND stages.readFixCycles AND stages.bumpFixCycles are all set (else a no-op — fully back-compat).
   */
  fixCycleCeiling?: number;
  /** optional LIVE progress sink — fire-and-forget; a throwing sink is swallowed so it never breaks the loop. */
  onEvent?: OptimizeEventSink;
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
  /**
   * The fixer's traced root cause, copied through from `CandidateEdit.foundRoot` (absent when the fixer traced
   * none). The CLI seam reads it to feed the distiller; core never interprets it. See {@link CandidateEdit.foundRoot}.
   */
  foundRoot?: string;
}

/** A node the driver DID NOT attempt because it hit the per-node fix-cycle ceiling — an escalation, not a
 * candidate (so it rides its own array, never a fake FixGateRecord with no candidateRef/verdict). */
export interface FixCycleSkip {
  node: string;
  /** the failed cycles already consumed (readFixCycles(node) at skip time). */
  cycles: number;
  /** the ceiling that was hit. */
  ceiling: number;
}

export interface FixGateResult {
  records: FixGateRecord[];
  /** nodes skipped at the fix-cycle ceiling (empty unless the ceiling was active AND hit). */
  skipped: FixCycleSkip[];
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
  const skipped: FixCycleSkip[] = [];
  // The per-node fix-cycle ceiling activates ONLY with the ceiling AND both counter stages — else a no-op
  // (fully backward-compatible: no stages, no behavior change). Core reads/bumps through the injected stages;
  // it persists NOTHING (boundary law: the SDK is logic only).
  const ceilingActive = opts.fixCycleCeiling != null && !!stages.readFixCycles && !!stages.bumpFixCycles;
  let attempted = 0;
  let accepted = 0;
  let tokens = 0;
  let stoppedReason: FixGateResult['stoppedReason'] = 'complete';

  // Fire-and-forget the progress event: a throwing sink (e.g. a broken stdout) must NEVER break the loop —
  // the loop is the source of truth, the stream is only a projection. No sink ⇒ a no-op.
  const safeEmit: OptimizeEventSink = (event) => {
    if (!opts.onEvent) return;
    try { opts.onEvent(event); } catch { /* swallow — the stream never gates the loop */ }
  };

  safeEmit({ type: 'triaged', defectCount: defects.length });

  for (const d of defects) {
    if (buffer.has(defectKey(d))) continue; // dead edit — don't re-propose

    // PER-NODE FIX-CYCLE CEILING: a node that has consumed >= the ceiling of failed cycles is ESCALATED, not
    // re-attempted — skip WITHOUT calling the fixer (no fixer-started, no attempted/token spend), surface it on
    // result.skipped, and emit a portable fix-cycle-ceiling event so the control plane routes it to a human.
    if (ceilingActive) {
      const cycles = stages.readFixCycles!(d.node);
      if (cycles >= opts.fixCycleCeiling!) {
        skipped.push({ node: d.node, cycles, ceiling: opts.fixCycleCeiling! });
        safeEmit({ type: 'fix-cycle-ceiling', node: d.node, cycles, ceiling: opts.fixCycleCeiling! });
        continue;
      }
    }

    if (attempted >= editBudget) { stoppedReason = 'edit-budget'; break; }
    if (opts.tokenBudget != null && tokens >= opts.tokenBudget) { stoppedReason = 'token-budget'; break; }

    // PROPOSE on a candidate COPY — never the live file.
    const candidateRef = await stages.prepareCandidate(d);
    safeEmit({ type: 'candidate-prepared', node: d.node, bucket: d.bucket, candidateRef });
    safeEmit({ type: 'fixer-started', node: d.node, bucket: d.bucket });
    const edit = await stages.fixer(d, { candidateRef, emit: (payload) => safeEmit({ type: 'fixer-trace', node: d.node, payload }) });
    // A cut-short fixer surfaces its reason STRUCTURALLY (edit.aborted, a typed return) — we re-emit it as a
    // first-class PORTABLE event so the control plane keys on the cutoff without sniffing the opaque emit trace.
    // This is a signal only; the loop below still scores/gates/lands this (0-edit) proposal exactly as normal.
    if (edit.aborted) safeEmit({ type: 'fixer-aborted', node: d.node, reason: edit.aborted.reason });
    safeEmit({ type: 'fixer-done', node: d.node, editsApplied: edit.editsApplied, tokensSpent: edit.tokensSpent ?? 0 });
    attempted++;
    tokens += edit.tokensSpent ?? 0;

    // SCORE the candidate on the held-out VAL slice, then GATE (pure arithmetic).
    const candidate = await stages.replayScore(d.node, candidateRef);
    safeEmit({ type: 'scored', node: d.node, baseScore: stages.baseScore(d.node), candidateScore: candidate });
    const verdict = evaluateGate({
      bucket: d.bucket,
      base: stages.baseScore(d.node),
      candidate,
      editsApplied: edit.editsApplied,
      ...(edit.candidatePassedProductChecks !== undefined ? { candidatePassedProductChecks: edit.candidatePassedProductChecks } : {}),
    });
    safeEmit({ type: 'gated', node: d.node, verdict });

    // DECIDE the landing (land.ts applies it physically): adopt iff accepted AND eligible AND the flag is set.
    let landed: FixGateRecord['landed'];
    if (!verdict.accept) {
      landed = 'discarded';
      buffer.add(defectKey(d)); // remember the dead edit
      // A REAL failed fix consumes a fix cycle (bounds the deferred re-attempt loop): a rejected verdict with
      // >=1 applied edit. An ACCEPT, a 0-edit, or an aborted (0-edit) proposal does NOT consume budget.
      if (ceilingActive && edit.editsApplied >= 1) stages.bumpFixCycles!(d.node);
    } else if (verdict.landPolicy === 'auto-adopt-eligible' && opts.autoAdopt) {
      landed = 'adopted';
      accepted++;
    } else {
      landed = 'staged';
      accepted++;
    }

    // Conditional-spread foundRoot: absent when the fixer traced none, so records stay byte-identical when unused
    // (and the "absent key" contract holds). A passive copy — core never interprets it; the CLI seam feeds it to the distiller.
    records.push({ node: d.node, bucket: d.bucket, candidateRef, editsApplied: edit.editsApplied, verdict, landed, tokensSpent: edit.tokensSpent ?? 0, ...(edit.foundRoot ? { foundRoot: edit.foundRoot } : {}) });
    safeEmit({ type: 'landed', node: d.node, decision: landed });
  }

  safeEmit({ type: 'stopped', reason: stoppedReason });
  return { records, skipped, attempted, accepted, stoppedReason };
}

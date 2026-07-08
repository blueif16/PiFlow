// optimize/substrate/retry-loop.ts — the OUTER loop that CONSUMES the gate's drop-back.
//
// `fixIssue` (fix.ts) is ONE attempt: candidate → fixer → prove → gate → stage/discard. On a SOFT-gate reject
// it emits a `dropback` (a coarse category + a diversification steer) that, until now, nothing read — a
// produced-but-unconsumed dead-end. This module closes it: it retries the fix with a FRESH, diversified fixer
// (the drop-back threaded in as CONTEXT, never the gate's rubric — the Goodhart fence, design §8), bounded by a
// TRIPLE independent cap (attempts · wall-time · token/cost). Past the bound it KEEPS THE BEST candidate and
// hands the human a closed decision menu (never a silent drop, never an auto-land of a rejected fix).
//
// SCOPE: this loop owns the SOFT-gate drop-back path ONLY. A discard with no `dropback` (the numeric-oracle
// path, or a no-edit attempt) carries no diversification signal, so it is NON-RETRYABLE here and passes
// through after one attempt — the numeric multi-round loop (optimize/loop.ts) owns that path.
//
// The system-wide "N consecutive exhausted ⇒ architecture problem" breaker is the SECOND level (design §8);
// it lives in the caller that iterates issues (the CLI), fed by this function's per-issue `outcome`.

import { fixIssue, type FixIssueOpts, type FixIssueResult, type RetryContext } from './fix.js';
import type { GateRejectCategory } from './gate.js';

/** Why the per-issue loop stopped. `accepted` = a fix staged; the three budget reasons = gave up (exhausted);
 *  `non-retryable` = a discard with no drop-back (numeric/no-edit) — one shot, passed through. */
export type RetryStopReason = 'accepted' | 'max-attempts' | 'wall-budget' | 'token-budget' | 'non-retryable';

export interface RetryAttemptRecord {
  attempt: number;
  decision?: 'staged' | 'discarded';
  dropback?: { category: GateRejectCategory; steer?: string };
  candidateRef: string;
  editsApplied: number;
  /** cost attributed to this attempt (via `attemptCost`); 0 when the cap is unwired. */
  cost: number;
}

/** The §6 escalation — a CLOSED decision menu handed to the human, never an open lament. */
export interface RetryEscalationPacket {
  issue: string;
  node: string;
  attempts: number;
  stoppedBy: RetryStopReason;
  /** what each rejected attempt tried, oldest→newest (category + steer) — the "already tried" for the human. */
  history: { attempt: number; category?: GateRejectCategory; steer?: string }[];
  /** every attempt's candidate dir, preserved on disk (nothing is deleted on give-up). */
  candidateRefs: string[];
  /** the candidate handed forward as best (heuristic on the scoreless soft path — see `bestIsHeuristic`). */
  bestCandidateRef: string;
  /** true when `best` was chosen without a numeric score (the soft path) — the human is the real selector. */
  bestIsHeuristic: boolean;
  /** the closed decision menu. */
  options: string[];
}

export interface FixWithRetriesOpts extends Omit<FixIssueOpts, 'attemptTag' | 'retry'> {
  /** hard per-issue attempt ceiling — the PRIMARY bound (default 3; empirical diminishing returns ~3–4). */
  maxAttempts?: number;
  /** optional wall-time ceiling across all attempts (ms), checked via `now` before each attempt. */
  maxWallMs?: number;
  /** optional token/cost ceiling across all attempts, summed via `attemptCost` before each attempt. */
  maxTokens?: number;
  /** clock seam (default `Date.now`) — the wall-time cap + deterministic test injection. */
  now?: () => number;
  /** per-attempt cost extractor (default `() => 0` — the token cap stays inert until the caller wires usage). */
  attemptCost?: (r: FixIssueResult) => number;
  /** test/offline seam for ONE attempt (default the real `fixIssue`). */
  fixOnce?: (issuePath: string, opts: FixIssueOpts) => Promise<FixIssueResult>;
}

export interface FixWithRetriesResult {
  issue: string;
  node: string;
  /** `accepted` = a staged fix; `exhausted` = gave up past a bound (best kept, human escalation);
   *  `passthrough` = a single non-retryable attempt (no drop-back to diversify from). */
  outcome: 'accepted' | 'exhausted' | 'passthrough';
  stoppedBy: RetryStopReason;
  attempts: RetryAttemptRecord[];
  /** present on `accepted`: the staged winner. */
  winning?: FixIssueResult;
  /** present on `exhausted`/`passthrough`: the candidate kept for the human (NEVER auto-landed). */
  best?: FixIssueResult;
  /** present on `exhausted`: the closed decision menu (§6). */
  escalation?: RetryEscalationPacket;
}

/**
 * Fix ONE issue with a bounded, diversifying retry loop (the outer loop that consumes the gate drop-back).
 * Each attempt is a FRESH `fixIssue` (scoped to its own `attempt-N` candidate dir) carrying the accumulated
 * drop-backs as a RetryContext — never the gate's rubric. Terminates on the FIRST of: an accept, the attempt
 * cap, the wall-time cap, or the token cap. On any budget exhaustion it keeps the best candidate and returns a
 * closed decision menu; it NEVER hangs (the cap is checked before every attempt) and NEVER auto-lands a reject.
 */
export async function fixIssueWithRetries(issuePath: string, opts: FixWithRetriesOpts): Promise<FixWithRetriesResult> {
  const {
    maxAttempts = 3,
    maxWallMs,
    maxTokens,
    now = Date.now,
    attemptCost = () => 0,
    fixOnce = fixIssue,
    ...fixOpts // every remaining FixIssueOpts field (incl. onEvent) is forwarded to each attempt verbatim
  } = opts;

  const start = now();
  const attempts: RetryAttemptRecord[] = [];
  const priorDropbacks: { category: GateRejectCategory; steer?: string }[] = [];
  const priorAccounts: string[] = [];
  let spentTokens = 0;
  let issue = '';
  let node = '';
  let lastResult: FixIssueResult | undefined;

  const exhausted = (stoppedBy: RetryStopReason): FixWithRetriesResult => {
    // Scoreless soft path: "best" is a HEURISTIC — the last (most-steered) candidate; the human is the real
    // selector, handed every preserved candidate. A numeric score would enable true best-selection (future).
    const best = lastResult;
    const escalation: RetryEscalationPacket = {
      issue,
      node,
      attempts: attempts.length,
      stoppedBy,
      history: attempts
        .filter((a) => a.dropback)
        .map((a) => ({ attempt: a.attempt, category: a.dropback?.category, steer: a.dropback?.steer })),
      candidateRefs: attempts.map((a) => a.candidateRef),
      bestCandidateRef: best?.candidateRef ?? '',
      bestIsHeuristic: true,
      options: [
        `adopt the best candidate as-is despite the reject after human review (${best?.candidateRef ?? 'n/a'})`,
        're-scope or re-frame the issue — the fixer may be aiming at a root it cannot reach',
        'route a stronger fixer tier / a different model at this issue and re-run',
        'defer: leave the issue OPEN and move on',
      ],
    };
    return { issue, node, outcome: 'exhausted', stoppedBy, attempts, best, escalation };
  };

  for (let attempt = 1; ; attempt++) {
    // Caps checked BEFORE each attempt (attempt 1 always runs). First-to-trip wins; the loop cannot run away.
    if (attempt > maxAttempts) return exhausted('max-attempts');
    if (maxWallMs != null && now() - start >= maxWallMs) return exhausted('wall-budget');
    if (maxTokens != null && spentTokens >= maxTokens) return exhausted('token-budget');

    const retry: RetryContext | undefined =
      attempt > 1 ? { attempt, priorDropbacks: [...priorDropbacks], priorAccounts: [...priorAccounts] } : undefined;

    const r = await fixOnce(issuePath, { ...(fixOpts as FixIssueOpts), attemptTag: `attempt-${attempt}`, retry });
    issue = r.issue;
    node = r.node;
    lastResult = r;
    const cost = attemptCost(r);
    spentTokens += cost;
    attempts.push({
      attempt,
      decision: r.decision,
      dropback: r.dropback,
      candidateRef: r.candidateRef,
      editsApplied: r.editsApplied,
      cost,
    });

    // ACCEPT ⇒ done (a staged fix; the human still adopts separately).
    if (r.decision === 'staged') {
      return { issue, node, outcome: 'accepted', stoppedBy: 'accepted', attempts, winning: r };
    }
    // A discard with NO drop-back (numeric-oracle path / a no-edit attempt) carries no diversification signal:
    // NON-RETRYABLE here — one shot, pass through (the numeric multi-round loop owns that path).
    if (!r.dropback) {
      return { issue, node, outcome: 'passthrough', stoppedBy: 'non-retryable', attempts, best: r };
    }
    // Soft-gate reject ⇒ accumulate the drop-back + account and loop to a FRESH, diversified fixer.
    priorDropbacks.push(r.dropback);
    priorAccounts.push(r.fixerAccount ?? '');
  }
}

export type { RetryContext };

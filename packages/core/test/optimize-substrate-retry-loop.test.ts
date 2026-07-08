// optimize/substrate/retry-loop.ts — the OUTER per-issue loop that consumes the gate's drop-back.
// Every attempt is the injected `fixOnce` seam (no real fixIssue / no live spawn), so the loop's control
// flow — caps, drop-back threading, keep-best, give-up — is exercised deterministically. The GIVE-UP path
// gets its own dedicated test (design §8: OpenHands shipped theirs BROKEN because it was never exercised).
//
// Run: npx vitest run packages/core/test/optimize-substrate-retry-loop.test.ts

import { describe, it, expect } from 'vitest';
import { fixIssueWithRetries, makeConsecutiveExhaustedBreaker, type RetryContext } from '../src/optimize/substrate/retry-loop.js';
import type { FixIssueOpts, FixIssueResult } from '../src/optimize/substrate/fix.js';

const attemptOf = (o: FixIssueOpts): number => Number((o.attemptTag ?? 'attempt-1').split('-')[1]);

const ISSUE = '/tpl/nodes/gameplay/issues/soggy-crust.md';
const baseOpts = { parentRunDir: '/run', templateDir: '/tpl', workspace: '/ws' } as const;

/** A SOFT-gate reject (carries a drop-back → retryable). */
function rejected(attempt: number): FixIssueResult {
  return {
    issue: 'soggy-crust',
    node: 'gameplay',
    candidateRef: `/run/staging/candidates/soggy-crust/attempt-${attempt}`,
    editsApplied: 1,
    proved: true,
    childId: `child-${attempt}`,
    gateVerdict: { decision: 'reject', rationale: `rejected on attempt ${attempt}`, category: 'band-aid', steer: `steer-${attempt}` },
    dropback: { category: 'band-aid', steer: `steer-${attempt}` },
    decision: 'discarded',
    deltaSummary: {},
    fixerAccount: `account-${attempt}`,
  };
}
/** A soft-gate ACCEPT (staged winner, no drop-back). */
function accepted(attempt: number): FixIssueResult {
  return { ...rejected(attempt), gateVerdict: { decision: 'accept', rationale: 'good' }, dropback: undefined, decision: 'staged' };
}

describe('fixIssueWithRetries — give-up path (the least-exercised, must not rot)', () => {
  it('gives up cleanly after maxAttempts consecutive rejects: bounded, keeps the best candidate, emits a closed decision menu', async () => {
    const calls: FixIssueOpts[] = [];
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 3,
      fixOnce: async (_p, o) => {
        calls.push(o);
        return rejected(calls.length);
      },
    });
    expect(res.outcome).toBe('exhausted');
    expect(res.stoppedBy).toBe('max-attempts');
    expect(res.attempts).toHaveLength(3); // exactly the cap — proves it does NOT loop forever
    expect(calls).toHaveLength(3);
    expect(res.winning).toBeUndefined();
    expect(res.best).toBeDefined(); // the best candidate is KEPT, never silently dropped
    expect(res.escalation).toBeDefined();
    expect(res.escalation!.attempts).toBe(3);
    expect(res.escalation!.options.length).toBeGreaterThan(0); // a CLOSED menu, not an open lament
    expect(res.escalation!.candidateRefs).toHaveLength(3); // every attempt's candidate preserved on disk
  });
});

describe('fixIssueWithRetries — drop-back consumption + accept paths', () => {
  it('threads each rejected attempt\'s drop-back into the NEXT fixer, accumulating oldest→newest (the closure)', async () => {
    const seenRetries: (RetryContext | undefined)[] = [];
    const seenTags: (string | undefined)[] = [];
    await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 3,
      fixOnce: async (_p, o) => {
        seenRetries.push(o.retry);
        seenTags.push(o.attemptTag);
        return rejected(seenRetries.length);
      },
    });
    // attempt 1 — no diversification context, its own candidate dir
    expect(seenRetries[0]).toBeUndefined();
    expect(seenTags[0]).toBe('attempt-1');
    // attempt 2 — carries attempt 1's drop-back + account
    expect(seenRetries[1]?.attempt).toBe(2);
    expect(seenRetries[1]?.priorDropbacks).toEqual([{ category: 'band-aid', steer: 'steer-1' }]);
    expect(seenRetries[1]?.priorAccounts).toEqual(['account-1']);
    expect(seenTags[1]).toBe('attempt-2');
    // attempt 3 — accumulates 1 AND 2, oldest→newest
    expect(seenRetries[2]?.priorDropbacks).toEqual([
      { category: 'band-aid', steer: 'steer-1' },
      { category: 'band-aid', steer: 'steer-2' },
    ]);
    expect(seenRetries[2]?.priorAccounts).toEqual(['account-1', 'account-2']);
  });

  it('stops after ONE attempt when the first fix is accepted (no retry, no escalation)', async () => {
    let calls = 0;
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      fixOnce: async () => {
        calls++;
        return accepted(1);
      },
    });
    expect(calls).toBe(1);
    expect(res.outcome).toBe('accepted');
    expect(res.attempts).toHaveLength(1);
    expect(res.winning?.decision).toBe('staged');
    expect(res.escalation).toBeUndefined();
  });

  it('returns accepted with the staged winner when a LATER retry succeeds', async () => {
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 4,
      fixOnce: async (_p, o) => (attemptOf(o) === 3 ? accepted(3) : rejected(attemptOf(o))),
    });
    expect(res.outcome).toBe('accepted');
    expect(res.stoppedBy).toBe('accepted');
    expect(res.attempts).toHaveLength(3);
    expect(res.winning?.decision).toBe('staged');
    expect(res.escalation).toBeUndefined();
  });

  it('passes a discard with NO drop-back through after ONE attempt (numeric-path / no-edit is non-retryable here)', async () => {
    let calls = 0;
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 5,
      fixOnce: async () => {
        calls++;
        return { ...rejected(1), gateVerdict: undefined, dropback: undefined, decision: 'discarded' };
      },
    });
    expect(calls).toBe(1); // did NOT spin — no diversification signal to retry from
    expect(res.outcome).toBe('passthrough');
    expect(res.stoppedBy).toBe('non-retryable');
    expect(res.best).toBeDefined();
  });
});

describe('fixIssueWithRetries — the triple cap (attempts · wall · tokens), first-to-trip wins', () => {
  it('stops on the WALL-TIME cap before the attempt cap', async () => {
    const times = [0 /* start */, 0 /* attempt-1 check */, 1000 /* attempt-2 check */];
    let i = 0;
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 5,
      maxWallMs: 500,
      now: () => times[Math.min(i++, times.length - 1)],
      fixOnce: async (_p, o) => rejected(attemptOf(o)),
    });
    expect(res.stoppedBy).toBe('wall-budget');
    expect(res.outcome).toBe('exhausted');
    expect(res.attempts).toHaveLength(1); // attempt 1 ran; attempt 2 tripped the wall cap first
  });

  it('stops on the TOKEN cap before the attempt cap', async () => {
    const res = await fixIssueWithRetries(ISSUE, {
      ...baseOpts,
      maxAttempts: 5,
      maxTokens: 150,
      attemptCost: () => 100, // 1st (spent 0), 2nd (spent 100), 3rd pre-check spent 200 ≥ 150 → trip
      fixOnce: async (_p, o) => rejected(attemptOf(o)),
    });
    expect(res.stoppedBy).toBe('token-budget');
    expect(res.outcome).toBe('exhausted');
    expect(res.attempts).toHaveLength(2);
  });
});

describe('makeConsecutiveExhaustedBreaker — the system-wide second-level breaker', () => {
  it('trips only on N CONSECUTIVE exhausted outcomes', () => {
    const b = makeConsecutiveExhaustedBreaker(3);
    expect(b.record('exhausted')).toBe(false);
    expect(b.record('exhausted')).toBe(false);
    expect(b.record('exhausted')).toBe(true); // 3rd consecutive → architecture-problem signal
    expect(b.tripped).toBe(true);
  });

  it('an accept RESETS the streak', () => {
    const b = makeConsecutiveExhaustedBreaker(3);
    b.record('exhausted');
    b.record('exhausted');
    expect(b.record('accepted')).toBe(false);
    expect(b.streak).toBe(0);
    expect(b.record('exhausted')).toBe(false); // streak restarts at 1
  });

  it('a passthrough is NEUTRAL — it neither increments nor resets (a different lane)', () => {
    const b = makeConsecutiveExhaustedBreaker(3);
    b.record('exhausted');
    b.record('passthrough'); // neutral
    b.record('exhausted');
    expect(b.record('exhausted')).toBe(true); // 3 exhausted despite the interleaved passthrough
  });

  it('limit 0 disables the breaker (never trips)', () => {
    const b = makeConsecutiveExhaustedBreaker(0);
    expect(b.record('exhausted')).toBe(false);
    expect(b.record('exhausted')).toBe(false);
    expect(b.tripped).toBe(false);
  });
});

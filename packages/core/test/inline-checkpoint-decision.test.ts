// (P3 · MUST-2) The PURE half of the inline hitl gate: how a human reply is INTERPRETED into an
// accept/reject decision + a reason (`interpretCheckpointReply`), and how that reason SURFACES in the
// re-run's consult preamble (`consultPreamble` — the decisive channel: without it a warm reject re-run
// gets an empty evidence block and learns nothing). Both are pure; example tests + the inline test-the-test.

import { describe, it, expect } from 'vitest';
import { interpretCheckpointReply } from '../src/runner/checkpoint.js';
import { consultPreamble } from '../src/checks.js';
import type { CheckpointSpec, FailureSignals } from '../src/index.js';

const confirm = (): CheckpointSpec => ({ kind: 'confirm', prompt: 'Approve?' });

describe('interpretCheckpointReply — a confirm reply is the accept/reject decision', () => {
  it('confirm=true ⇒ ACCEPT', () => {
    // test-the-test: flipping the impl to `value !== true` turns this red.
    expect(interpretCheckpointReply(confirm(), true).accept).toBe(true);
  });

  it('confirm=false ⇒ REJECT, carrying the human free-text reason verbatim', () => {
    const d = interpretCheckpointReply(confirm(), false, 'the intro is too long');
    expect(d.accept).toBe(false);
    expect(d.reason).toBe('the intro is too long');
  });

  it('confirm=false with NO reason still REJECTS with a non-empty reason (the re-run must learn SOMETHING)', () => {
    const d = interpretCheckpointReply(confirm(), false);
    expect(d.accept).toBe(false);
    expect(d.reason && d.reason.length, 'a reject must yield a non-empty reason').toBeTruthy();
  });

  it('input: an accept token ACCEPTS; other text REJECTS with the typed text as the reason', () => {
    const spec: CheckpointSpec = { kind: 'input', prompt: 'Feedback?' };
    expect(interpretCheckpointReply(spec, 'approve').accept).toBe(true);
    const rej = interpretCheckpointReply(spec, 'shorten section 3');
    expect(rej.accept).toBe(false);
    expect(rej.reason).toBe('shorten section 3');
  });

  it('select: an accept-token choice ACCEPTS; another choice REJECTS with the choice as the reason', () => {
    const spec: CheckpointSpec = { kind: 'select', prompt: 'Pick', choices: ['approve', 'revise'] };
    expect(interpretCheckpointReply(spec, 'approve').accept).toBe(true);
    const rej = interpretCheckpointReply(spec, 'revise');
    expect(rej.accept).toBe(false);
    expect(rej.reason).toContain('revise');
  });
});

describe('consultPreamble — a human reject reason reaches the re-run evidence', () => {
  const baseSig = (): FailureSignals => ({
    status: 'error',
    issues: [],
    summary: '',
    missing: [],
    schemaInvalid: [],
    returnSchemaInvalid: [],
    failedChecks: [],
    killedTimeout: false,
    killedStall: false,
    exitCode: 0,
    stderrTail: '',
    parsedOk: true,
  });

  it('surfaces the rejectReason in the evidence block (else the warm re-run learns nothing)', () => {
    const pre = consultPreamble({ ...baseSig(), rejectReason: 'the intro is too long' });
    expect(pre).toContain('the intro is too long');
    expect(pre.toLowerCase()).toContain('reviewer'); // labelled as a human-review rejection, not a generic gap
  });

  it('omits the human-reject line when there is no rejectReason (no false human signal)', () => {
    expect(consultPreamble(baseSig()).toLowerCase()).not.toContain('reviewer');
  });
});

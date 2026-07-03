// G5 — HITL reply authoring (`piflowctl reply`). PURE LOGIC (test-discipline §0): `coerceReplyValue` and
// `buildReply` are string→typed-value coercers a CLI/TUI courier calls before writing a reply file. The
// load-bearing property is the ROUND-TRIP: whatever `buildReply` assembles from a raw string must pass the
// RUNNER'S OWN `validateReply` — that is the independent oracle proving the CLI can never write a reply
// the runner would silently ignore. Exercised through `@piflow/core`'s public export (index.ts), so this
// test also proves the export wiring, not just the underlying functions.
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readMarker,
  validateReply,
  coerceReplyValue,
  buildReply,
  checkpointMarkerFile,
  type CheckpointMarker,
  type CheckpointReply,
} from '../src/index.js';
import { buildMarker } from '../src/runner/checkpoint.js';

async function tmpRun(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-checkpoint-reply-'));
}

// ── fixtures: one authentic marker per kind, built via the real buildMarker (so `hash` is genuine) ──

const confirmMarker: CheckpointMarker = buildMarker('gate', 'Gate', { kind: 'confirm', prompt: 'proceed?' }, 'now');
const inputMarker: CheckpointMarker = buildMarker('gate', 'Gate', { kind: 'input', prompt: 'name?' }, 'now');
const selectMarker: CheckpointMarker = buildMarker(
  'gate',
  'Gate',
  { kind: 'select', prompt: 'A or B?', choices: ['A', 'B'], default: 'A' },
  'now',
);

describe('coerceReplyValue — string → typed value per marker kind', () => {
  it('confirm: yes-words → true, no-words → false, gibberish → ok:false', () => {
    expect(coerceReplyValue(confirmMarker, 'true')).toEqual({ ok: true, value: true });
    expect(coerceReplyValue(confirmMarker, 'yes')).toEqual({ ok: true, value: true });
    expect(coerceReplyValue(confirmMarker, 'approve')).toEqual({ ok: true, value: true });
    expect(coerceReplyValue(confirmMarker, 'false')).toEqual({ ok: true, value: false });
    expect(coerceReplyValue(confirmMarker, 'no')).toEqual({ ok: true, value: false });
    expect(coerceReplyValue(confirmMarker, 'reject')).toEqual({ ok: true, value: false });
    expect(coerceReplyValue(confirmMarker, 'maybe').ok).toBe(false);
  });

  it('input: any non-empty string passes through verbatim; empty string is rejected', () => {
    expect(coerceReplyValue(inputMarker, 'hi')).toEqual({ ok: true, value: 'hi' });
    expect(coerceReplyValue(inputMarker, '').ok).toBe(false);
  });

  it('select: a value in choices passes through; a value outside choices is rejected', () => {
    expect(coerceReplyValue(selectMarker, 'B')).toEqual({ ok: true, value: 'B' });
    expect(coerceReplyValue(selectMarker, 'Z').ok).toBe(false);
  });
});

describe('buildReply — round-trips through the RUNNER\'s own validateReply (the independent oracle)', () => {
  it('confirm: buildReply("yes") assembles a reply validateReply ACCEPTS with value===true', () => {
    const built = buildReply(confirmMarker, 'yes', 'operator');
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    // The RUNNER's own validator is the oracle — assert on ITS verdict first (this is what a coerce-typing
    // regression breaks: a non-boolean confirm value is REJECTED here, independent of buildReply's own shape).
    const verdict = validateReply(confirmMarker, built.reply);
    expect(verdict).toEqual({ ok: true, value: true });
    expect(built.reply).toMatchObject({ nodeId: 'gate', hash: confirmMarker.hash, value: true, by: 'operator' });
  });

  it('input: buildReply("Ada") assembles a reply validateReply ACCEPTS with value==="Ada"', () => {
    const built = buildReply(inputMarker, 'Ada');
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    const verdict = validateReply(inputMarker, built.reply);
    expect(verdict).toEqual({ ok: true, value: 'Ada' });
  });

  it('select: buildReply("B") assembles a reply validateReply ACCEPTS with value==="B"', () => {
    const built = buildReply(selectMarker, 'B');
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    const verdict: { ok: boolean; value?: unknown; reason?: string } = validateReply(selectMarker, built.reply as CheckpointReply);
    expect(verdict).toEqual({ ok: true, value: 'B' });
  });

  it('propagates coercion failure BEFORE assembling a reply (fail loud, never write a bad file)', () => {
    const built = buildReply(confirmMarker, 'maybe');
    expect(built.ok).toBe(false);
  });
});

describe('readMarker — exported from @piflow/core, reads the on-disk marker a CLI reply needs', () => {
  it('reads a real marker written to checkpointMarkerFile, carrying the authentic hash', async () => {
    const runDir = await tmpRun();
    await fs.mkdir(path.dirname(checkpointMarkerFile(runDir, 'gate')), { recursive: true });
    await fs.writeFile(checkpointMarkerFile(runDir, 'gate'), JSON.stringify(selectMarker));

    const read = await readMarker(runDir, 'gate');
    expect(read).toEqual(selectMarker);
    expect(read!.hash).toBe(selectMarker.hash);
  });

  it('returns null when no marker exists (no pending checkpoint under that id)', async () => {
    const runDir = await tmpRun();
    expect(await readMarker(runDir, 'nope')).toBeNull();
  });
});

// G5 — HUMAN CHECKPOINT (HITL). The PURE half of the checkpoint mechanism: the marker/reply schemas, the
// question hash (so an edited question re-prompts on resume — folds into the §G4 envelope idea), and the
// reply VALIDATOR (the runner is the sole authority — it re-validates every reply before acting on it).
// The runner orchestration (write marker, park the lane, poll for the reply, journal, resume) lives in
// runner.ts; the I/O reader/writer below mirror status.ts/journal.ts (atomic, fs-only).
//
// Design contract: docs/specs/wiring-g5-hitl-checkpoint.md. Locked decisions: a `checkpoint` NODE KIND;
// the filesystem reply-file as the only courier; per-checkpoint `headless: 'default'|'abort'`; the runner
// re-validates (echoed hash matches, kind/choices/non-empty) — a malformed/stale reply is ignored.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CheckpointSpec, RunState } from '../types.js';
import { checkpointsDir, checkpointMarkerFile, checkpointReplyFile, stateFile, piDir } from './layout.js';

// ── marker + reply schemas (the contract the GUI/console builds against) ────────────────────────────

/** The runner-written pending-question marker (`.pi/checkpoints/<id>.json`). */
export interface CheckpointMarker {
  nodeId: string;
  label: string;
  kind: CheckpointSpec['kind'];
  prompt: string;
  choices?: string[];
  default?: unknown;
  headless: 'default' | 'abort';
  status: 'pending' | 'resolved';
  askedAt: string;
  /** sha256 over (prompt + kind + choices + default) — echoed by a reply so a stale/re-asked question is rejected. */
  hash: string;
  timeoutMs?: number;
}

/** A courier-written reply (`.pi/checkpoints/<id>.reply.json`) — the runner re-validates this; never trusts it. */
export interface CheckpointReply {
  nodeId: string;
  /** Echoed marker hash — a reply for a DIFFERENT (re-asked/stale) question no longer matches → rejected. */
  hash: string;
  value: unknown;
  /**
   * (P3 · inline hitl) The rejecting human's FREE-TEXT reason. For a `confirm` reject (`value:false`) the
   * boolean carries no words, so the WHY rides here and is fed VERBATIM to the producer's warm re-run
   * (`consultPreamble`). Ignored on an accept; for `input`/`select` the reply `value` already IS the text,
   * so `reason` is optional there. NOT part of `validateReply` (it validates the decision `value`, not prose).
   */
  reason?: string;
  by?: string;
  at?: string;
}

// ── the question hash (an edited question → a new hash → a re-prompt on resume) ─────────────────────

/** sha256 over the question identity. A prompt/kind/choices/default edit flips it, invalidating old replies. */
export function hashCheckpoint(spec: Pick<CheckpointSpec, 'kind' | 'prompt' | 'choices' | 'default'>): string {
  const canonical = JSON.stringify({
    kind: spec.kind,
    prompt: spec.prompt,
    choices: spec.choices ?? null,
    default: spec.default ?? null,
  });
  return 'sha256:' + createHash('sha256').update(canonical).digest('hex');
}

/** Build the pending marker for a checkpoint node (status `pending`, stamped `askedAt`). PURE. */
export function buildMarker(nodeId: string, label: string, spec: CheckpointSpec, askedAt: string): CheckpointMarker {
  const marker: CheckpointMarker = {
    nodeId,
    label,
    kind: spec.kind,
    prompt: spec.prompt,
    headless: spec.headless ?? 'default',
    status: 'pending',
    askedAt,
    hash: hashCheckpoint(spec),
  };
  if (spec.choices !== undefined) marker.choices = spec.choices;
  if (spec.default !== undefined) marker.default = spec.default;
  if (spec.timeoutMs !== undefined) marker.timeoutMs = spec.timeoutMs;
  return marker;
}

// ── the reply VALIDATOR (the runner is the authority — pure, real assertions) ───────────────────────

export type ReplyVerdict =
  | { ok: true; value: unknown }
  | { ok: false; reason: string };

/**
 * Validate a parsed reply against the marker the runner itself wrote. A reply is ACCEPTED only when:
 *  - its echoed `hash` matches the marker hash (else it answers a stale/re-asked question → reject);
 *  - the value fits the `kind`: `confirm` ⇒ boolean; `input` ⇒ a non-empty string; `select` ⇒ a value in
 *    the marker's `choices`.
 * Anything else (wrong shape, empty input, choice ∉ choices, hash mismatch) is REJECTED — the runner keeps
 * waiting. A malformed/unparseable file never reaches here (the reader returns null); the lane never crashes.
 */
export function validateReply(marker: CheckpointMarker, reply: CheckpointReply): ReplyVerdict {
  if (!reply || typeof reply !== 'object') return { ok: false, reason: 'reply is not an object' };
  if (reply.hash !== marker.hash) return { ok: false, reason: 'hash mismatch (stale or re-asked question)' };
  const v = reply.value;
  switch (marker.kind) {
    case 'confirm':
      if (typeof v !== 'boolean') return { ok: false, reason: 'confirm reply must be a boolean' };
      return { ok: true, value: v };
    case 'input':
      if (typeof v !== 'string' || v.length === 0) return { ok: false, reason: 'input reply must be a non-empty string' };
      return { ok: true, value: v };
    case 'select': {
      const choices = marker.choices ?? [];
      if (!choices.includes(v as string)) return { ok: false, reason: `select reply must be one of: ${choices.join(', ')}` };
      return { ok: true, value: v };
    }
    default:
      return { ok: false, reason: `unknown checkpoint kind: ${String(marker.kind)}` };
  }
}

// ── (P3 · inline hitl) reply → accept/reject DECISION (pure) ────────────────────────────────────────
// The INLINE gate (a producer that ran its model, then pauses for a human) needs an ACCEPT/REJECT verdict
// + a reason to feed a rejected re-run — NOT the standalone checkpoint's "resolve ok carrying the value".
// This is that interpretation, kept pure + here next to `validateReply` (a courier decides, this decides).

/** The inline hitl gate's verdict on a human reply: promote the producer, or send it back with a reason. */
export interface InlineCheckpointDecision {
  /** true ⇒ the producer's output is accepted (the node promotes); false ⇒ re-run carrying `reason`. */
  accept: boolean;
  /** The resolved reply value (the boolean / string / choice) — recorded for observe. */
  value?: unknown;
  /** On a REJECT, the WHY handed to the warm re-run's consult preamble. Absent on an accept. */
  reason?: string;
}

/** Words a free-text (`input`/`select`) reply may use to APPROVE — everything else is a revision request. */
const ACCEPT_TOKENS = new Set(['approve', 'accept', 'ok', 'yes', 'pass', 'lgtm', 'confirm', 'y']);
const isAcceptToken = (v: unknown): boolean =>
  typeof v === 'string' && ACCEPT_TOKENS.has(v.trim().toLowerCase());

/**
 * Interpret a resolved checkpoint reply value into an inline-gate accept/reject DECISION. PURE.
 *  - `confirm` — the boolean IS the verdict: `true` accepts; `false` REJECTS, carrying the human's free-text
 *    `reason` (or a default, so a rejected re-run is never fed an empty critique).
 *  - `input` / `select` — an ACCEPT-token value (approve/ok/…) accepts; ANY other value is a revision request
 *    → REJECT, with that value text AS the reason (a `select` names the chosen option). So every kind has an
 *    accept path, and `confirm` is the primary approve/reject interaction.
 */
export function interpretCheckpointReply(
  spec: CheckpointSpec,
  value: unknown,
  reason?: string,
): InlineCheckpointDecision {
  switch (spec.kind) {
    case 'confirm':
      return value === true
        ? { accept: true, value }
        : { accept: false, value, reason: reason ?? 'the human reviewer rejected the output (no reason given)' };
    case 'input':
    case 'select': {
      if (isAcceptToken(value)) return { accept: true, value };
      const text = typeof value === 'string' && value.length ? value : reason;
      return { accept: false, value, reason: text ?? 'the human reviewer requested a revision' };
    }
    default:
      return { accept: false, value, reason: reason ?? 'the human reviewer rejected the output' };
  }
}

// ── string → typed value coercion (the INPUT-side twin of validateReply, for string couriers: CLI/TUI) ──
// A CLI/TUI hands a raw STRING; the marker's `kind` decides the typed `value` the runner then validates.
// `confirm` maps yes/no words → a boolean (the runner requires a boolean); `input` is the string verbatim;
// `select` is the string verbatim (validateReply checks it ∈ choices). Kept HERE next to validateReply so
// the two stay one home — a courier coerces, the runner re-validates. PURE.

/** Coerce a raw string answer to the typed `value` a reply of this marker's `kind` needs. PURE. */
export function coerceReplyValue(
  marker: CheckpointMarker,
  raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  switch (marker.kind) {
    case 'confirm': {
      const t = raw.trim().toLowerCase();
      if (['true', 'yes', 'y', '1', 'approve', 'confirm', 'ok'].includes(t)) return { ok: true, value: true };
      if (['false', 'no', 'n', '0', 'reject', 'deny', 'abort'].includes(t)) return { ok: true, value: false };
      return { ok: false, reason: `confirm expects yes/no (approve/reject) — got "${raw}"` };
    }
    case 'input':
      if (raw.length === 0) return { ok: false, reason: 'input expects a non-empty string' };
      return { ok: true, value: raw };
    case 'select': {
      const choices = marker.choices ?? [];
      if (!choices.includes(raw)) return { ok: false, reason: `select expects one of: ${choices.join(', ')}` };
      return { ok: true, value: raw };
    }
    default:
      return { ok: false, reason: `unknown checkpoint kind: ${String(marker.kind)}` };
  }
}

/**
 * Assemble the full courier reply for a marker from a raw string answer: coerce the value per `kind`, then
 * echo the marker `hash` + `nodeId` so the runner's `validateReply` ACCEPTS it. Returns the reason on a bad
 * value (before any file is written) so a caller can fail loud instead of writing a reply the runner ignores.
 * PURE — the caller writes the returned reply to `checkpointReplyFile`. `by` is optional provenance.
 */
export function buildReply(
  marker: CheckpointMarker,
  raw: string,
  by?: string,
): { ok: true; reply: CheckpointReply } | { ok: false; reason: string } {
  const c = coerceReplyValue(marker, raw);
  if (!c.ok) return c;
  const reply: CheckpointReply = { nodeId: marker.nodeId, hash: marker.hash, value: c.value };
  if (by) reply.by = by;
  return { ok: true, reply };
}

// ── I/O: write the marker · read a reply (fs-only, never throws on a missing/torn file) ─────────────

/** Write the pending marker atomically into the run dir (mkdir -p the checkpoints namespace first). */
export async function writeMarker(run: string, marker: CheckpointMarker): Promise<void> {
  await fs.mkdir(checkpointsDir(run), { recursive: true });
  const file = checkpointMarkerFile(run, marker.nodeId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(marker, null, 2));
  await fs.rename(tmp, file);
}

/** Read a checkpoint marker, or null when absent/unparseable. */
export async function readMarker(run: string, nodeId: string): Promise<CheckpointMarker | null> {
  try {
    return JSON.parse(await fs.readFile(checkpointMarkerFile(run, nodeId), 'utf8')) as CheckpointMarker;
  } catch {
    return null;
  }
}

/**
 * Read a courier-written reply, or null when the file is ABSENT or UNPARSEABLE. A torn/half-written file
 * returns null so the runner's wait simply persists (never a crash) — the courier rewrites it next poll.
 */
export async function readReply(run: string, nodeId: string): Promise<CheckpointReply | null> {
  try {
    const raw = await fs.readFile(checkpointReplyFile(run, nodeId), 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj as CheckpointReply;
  } catch {
    return null;
  }
}

// ── crash-safety journal: `.pi/state.json` `__checkpoints__` (the per-checkpoint pending/resolved slot) ──
// A pending checkpoint records its wait into the SAME `state.json` the stage barrier checkpoints, under a
// RESERVED `__checkpoints__` channel. On a crash mid-wait, on restart the runner sees an unresolved entry
// and RE-ENTERS the wait (re-reads the marker, does NOT re-ask). The reserved key never collides with a
// product RunState channel (a `{{state.__checkpoints__}}` token is implausible). The read-modify-write
// preserves every OTHER channel (it never clobbers the barrier's state).

/** The reserved RunState channel name carrying the per-node checkpoint journal. */
export const CHECKPOINT_CHANNEL = '__checkpoints__';

/** One node's crash-safety slot under `__checkpoints__`. */
export interface CheckpointJournalSlot {
  status: 'pending' | 'resolved';
  hash: string;
  askedAt: string;
  reply?: unknown;
  resolvedAt?: string;
}

/**
 * (G5) The OBSERVE view of a checkpoint — the marker (question) cross-checked against the `__checkpoints__`
 * journal (resolution). Shared so `buildRunView` + `readRunModel` build the SAME shape. Returns null when no
 * marker exists for the node. The `status` is taken from the JOURNAL when a slot exists (the resolution is
 * authoritative there — observe recomputes it from disk, never trusting a stale marker `status`), else the
 * marker's own `status`. SYNCHRONOUS over already-read JSON so both readers (sync runView, async read) reuse it.
 */
export function checkpointViewFrom(
  marker: CheckpointMarker | null,
  slot: CheckpointJournalSlot | undefined,
): {
  status: 'pending' | 'resolved';
  kind: CheckpointMarker['kind'];
  prompt: string;
  choices?: string[];
  default?: unknown;
  reply?: unknown;
  askedAt?: string;
  hash: string;
} | null {
  if (!marker) return null;
  const resolved = slot?.status === 'resolved' && slot.hash === marker.hash;
  const view: ReturnType<typeof checkpointViewFrom> = {
    status: resolved ? 'resolved' : 'pending',
    kind: marker.kind,
    prompt: marker.prompt,
    askedAt: marker.askedAt,
    hash: marker.hash,
  };
  if (marker.choices !== undefined) view.choices = marker.choices;
  if (marker.default !== undefined) view.default = marker.default;
  if (resolved) view.reply = slot?.reply;
  return view;
}

/** Read the `__checkpoints__` map off `.pi/state.json` (or `{}` when absent). */
export async function readCheckpointJournal(run: string): Promise<Record<string, CheckpointJournalSlot>> {
  try {
    const state = JSON.parse(await fs.readFile(stateFile(run), 'utf8')) as RunState;
    const ch = state[CHECKPOINT_CHANNEL];
    return ch && typeof ch === 'object' ? (ch as Record<string, CheckpointJournalSlot>) : {};
  } catch {
    return {};
  }
}

/**
 * Read-modify-write ONE node's `__checkpoints__` slot into `.pi/state.json`, preserving every other channel
 * (incl. the barrier's). Atomic temp+rename. Returns the written slot. Serialized per run dir so a barrier
 * persist and a checkpoint journal write never interleave-lose each other.
 */
const ckChains = new Map<string, Promise<void>>();
export function journalCheckpoint(run: string, nodeId: string, slot: CheckpointJournalSlot): Promise<void> {
  const prev = ckChains.get(run) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    await fs.mkdir(piDir(run), { recursive: true });
    let state: RunState = {};
    try { state = JSON.parse(await fs.readFile(stateFile(run), 'utf8')) as RunState; } catch { /* fresh */ }
    const map = (state[CHECKPOINT_CHANNEL] && typeof state[CHECKPOINT_CHANNEL] === 'object'
      ? state[CHECKPOINT_CHANNEL]
      : {}) as Record<string, CheckpointJournalSlot>;
    map[nodeId] = slot;
    state[CHECKPOINT_CHANNEL] = map;
    const tmp = `${stateFile(run)}.${process.pid}.ck.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, stateFile(run));
  });
  ckChains.set(run, next);
  return next;
}

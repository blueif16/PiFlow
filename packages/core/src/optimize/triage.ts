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
//                     said FUNCTIONALITY needs — so it is decidable now, NOT defaulted to LAPSE. A Tier-0
//                     disqualifier whose OWN recorded issues NAME a code/contract cause (schema breach, a
//                     skipped schema gate, a watchdog kill, a staging race) is FUNCTIONALITY too — a concrete
//                     signal, not a shrug (see `codeSignalOf`).
//   • LAPSE         ← a self-originating structural failure with no code signal: the default-when-unsure.
//   • SKILL         ← the SAME failure signature RECURRED across runs (the recurrence reader of Leg-A memory.md,
//                     shipped): a one-off residual is LAPSE, but a signature at/over the threshold means the
//                     skill prose is wrong/underspecified, not the executor. No recurrence signal ⇒ stays LAPSE.
//
// The projector writes NOTHING and invents NO prose — the deep free-text root-cause trace the human used to
// hand-write is the FIXER's job. This emits pointers (failing check ids, the upstream chain), never a story.

import type { RunDigest, RootCause, NodeDigest } from '../observe/telemetry.js';
import type { NodeScore, Defect, Confidence, CriteriaFixture, Tier1Result } from './types.js';
import { signatureOf, type RecurrenceIndex, type RecurrenceHit } from './recurrence.js';

export interface TriageOpts {
  /** the product's per-node quality bar (informs a future SKILL/prose-judge; unused by the MVP buckets). */
  criteria?: CriteriaFixture;
  /** the cross-run recurrence index (Leg-A memory.md) keyed by signatureOf — the SKILL signal. */
  recurrence?: RecurrenceIndex;
  /** minimum recurrence count for a residual LAPSE to flip to SKILL (default 1). */
  skillThreshold?: number;
}

/** A Tier-1 outcome that MEASURED and FAILED (abstain is not a failure). */
const tier1Failed = (s: NodeScore): boolean => !!s.tier1 && !s.tier1.abstained && !s.tier1.passed;

/** A node earns a worklist item iff it has a real problem signal — and abstained nodes never do (re-measure). */
const isDefect = (s: NodeScore): boolean => !s.abstained && (s.tier0.disqualified || tier1Failed(s));

// ── STRUCTURAL COVERAGE — a self-originating failure whose OWN recorded signals name a code/contract-level
// cause is NOT the same as a bare "something went wrong". `node-lifecycle.ts` stamps these onto the node's
// record (schemaInvalid/schemaSkipped/killedTimeout/killedStall/a staged-input race/a failed integrity check
// ride `issues[]`; op[] action failures ride the DEDICATED TYPED `opFailures` channel, A1) but the fold above
// never reads them — a Tier-0 disqualifier with a rich, concrete cause was silently indistinguishable from
// one with NONE, so it collapsed into the low-confidence LAPSE default (the corpus-protection rule is right
// for a TRULY signal-less slip, wrong for a named contract breach the fixer can act on). Matches the
// issue-string vocabulary node-lifecycle.ts writes (op failures are read off the typed field, not this regex).
const CODE_SIGNAL = /contract breach|schema (gate skipped|invalid)|killed:|integrity check failed|staging/i;

/** The first recorded signal (if any) on `node`'s own digest entry that names a code/contract-level cause. */
function codeSignalOf(node: string, digest: RunDigest): string | null {
  const nd = digest.nodes.find((n) => n.id === node);
  if (!nd) return null;
  // (A1) An op[] action failure rides the DEDICATED TYPED `opFailures` channel — never the `issues[]` string
  // (the user's law: op has nothing to do with the issue system). Read it directly as the op-failure signal
  // (replacing the old `op failed` grep of `issues[]`). Purely additive EVIDENCE: it feeds the SAME structural
  // routing op failures always drove — it mints no issue and introduces no new coupling.
  const opFail = nd.opFailures?.[0];
  if (opFail) return `op failed — ${opFail.detail}`;
  return nd.issues.find((i) => CODE_SIGNAL.test(i)) ?? null;
}

export function triage(scores: NodeScore[], digest: RunDigest, opts: TriageOpts = {}): Defect[] {
  const rootCauseOf = new Map(digest.rootCauses.map((rc) => [rc.failed, rc]));
  const threshold = opts.skillThreshold ?? 1;
  const defects: Defect[] = [];
  for (const s of scores) {
    if (!isDefect(s)) continue;
    const rc = rootCauseOf.get(s.node);
    if (rc && rc.earliestUpstream !== rc.failed) {
      defects.push(archDefect(s, rc));
    } else if (tier1Failed(s) && !s.tier0.disqualified) {
      defects.push(functionalityDefect(s, s.tier1!));
    } else {
      // A self-originating structural failure. A NAMED code/contract signal (schema breach, a staging race,
      // a watchdog kill, …) is concrete and actionable — route it FUNCTIONALITY before falling back to the
      // recurrence check. Only a truly signal-less failure is a one-off LAPSE, unless the SAME signature has
      // RECURRED — recurrence at/over the threshold means the skill prose is wrong, not the executor (SKILL).
      const signal = codeSignalOf(s.node, digest);
      if (signal) {
        defects.push(structuralDefect(s, signal));
      } else {
        const hit = opts.recurrence?.get(signatureOf(s));
        if (hit && hit.count >= threshold) {
          defects.push(skillDefect(s, hit));
        } else {
          defects.push(lapseDefect(s));
        }
      }
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
  // Runtime crashes lead the evidence: an uncaught error that wedges the loop is the DOMINATING root cause and
  // masks the per-check failures (gs01 M3: a TypeError froze update(), failing 4 fidelity + completability at
  // once). The fixer must trace THIS first, not patch a downstream symptom.
  const consoleErrors = (t1.consoleErrors ?? []).map((e) => `runtime-console-error: ${e}`);
  return {
    node: s.node,
    bucket: 'FUNCTIONALITY',
    symptom,
    evidence: [
      ...consoleErrors,
      ...failed.map((c) => `check:${c.id}`),
      `fix-surface: product code in ${s.node}'s owns/readScope (owner traced by the fixer)`,
    ],
    confidence,
  };
}

// ── ③b STRUCTURAL — a self-originating failure whose OWN recorded issues name a code/contract-level cause
// (a schema breach, a skipped schema gate, a watchdog kill, a staged-input race) — a concrete, actionable
// signal, so it does NOT collapse into the low-confidence LAPSE default the way a truly signal-less slip does.
function structuralDefect(s: NodeScore, signal: string): Defect {
  return {
    node: s.node,
    bucket: 'FUNCTIONALITY',
    symptom: `${s.node} ${s.tier0.reason ?? 'failed'} — ${signal}`,
    evidence: [`issue:${signal}`, `fix-surface: product code/config in ${s.node}'s owns/readScope or its staging setup`],
    confidence: 'medium',
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

// ── ② SKILL — the same signature RECURRED; the prose is wrong/underspecified, not a one-off slip ─────────
// The recurrence signal is now PRESENT (Leg-A memory.md), so — unlike LAPSE — this sets NO `needsSignal`.
function skillDefect(s: NodeScore, hit: RecurrenceHit): Defect {
  return {
    node: s.node,
    bucket: 'SKILL',
    symptom: `${s.node} recurred ${hit.count}× (same signature) — the skill is wrong/underspecified, not a one-off slip`,
    evidence: [
      `recurrence:${hit.count}`,
      ...(hit.lesson?.prevention ? [`prevention: ${hit.lesson.prevention}`] : []),
      ...(hit.lesson?.root ? [`root: ${hit.lesson.root}`] : []),
      ...(hit.lesson?.okfSlice ? [`code-map: [[${hit.lesson.okfSlice}]]`] : []),
      `fix-surface: ${s.node}'s envelope (prompt.md / SKILL.md / node.json)`,
    ],
    confidence: 'medium',
    // The two-leg scope-context, as STRUCTURED data (the fixer reads this, not the evidence strings above).
    // Pin the Leg-B link as the KEY only — the CLI seam dereferences it to `codeMap` at fix time (resolve-at-
    // read); this projector stays pure (no filesystem, no copy of the slice body).
    scope: {
      recurrence: hit.count,
      ...(hit.lesson?.root ? { root: hit.lesson.root } : {}),
      ...(hit.lesson?.prevention ? { prevention: hit.lesson.prevention } : {}),
      ...(hit.lesson?.okfSlice ? { okfSlice: hit.lesson.okfSlice } : {}),
    },
  };
}

// optimize/events.ts — the LIVE progress surface for the FIX→GATE loop (v1.5 §6). A DEDICATED sink, NOT the
// runner's EventSink/PiEvent: the optimize loop is out-of-band (post-run, never an in-DAG node) so it gets its
// own typed event stream rather than rerouting through the run-time recorder. The driver emits one event per
// phase boundary, fire-and-forget — a throwing sink never breaks the loop (the loop is the source of truth;
// the stream is a projection). The product's fixer sub-trace rides through as an OPAQUE payload: core emits it
// verbatim and NEVER inspects it (the fixer is context-isolated; its internals are not core's concern).

import type { GateVerdict } from './gate.js';
import type { DefectBucket } from './types.js';
import type { FixGateResult } from './driver.js';

export type OptimizeEvent =
  | { type: 'triaged'; defectCount: number }
  | { type: 'candidate-prepared'; node: string; bucket: DefectBucket; candidateRef: string }
  | { type: 'fixer-started'; node: string; bucket: DefectBucket }
  | { type: 'fixer-trace'; node: string; payload: Record<string, unknown> }   // opaque product sub-trace; core NEVER inspects payload
  | { type: 'fixer-aborted'; node: string; reason: string }                   // fixer cut short (watchdog/timeout); portable cutoff signal, read from the fixer's TYPED return (not the opaque payload)
  | { type: 'fixer-done'; node: string; editsApplied: number; tokensSpent: number }
  | { type: 'scored'; node: string; baseScore: number | null; candidateScore: number | null }
  | { type: 'gated'; node: string; verdict: GateVerdict }
  | { type: 'landed'; node: string; decision: 'adopted' | 'staged' | 'discarded' }
  | { type: 'fix-cycle-ceiling'; node: string; cycles: number; ceiling: number } // node hit the per-node re-attempt bound → skipped, escalate to a human
  | { type: 'stopped'; reason: FixGateResult['stoppedReason'] };

export type OptimizeEventSink = (event: OptimizeEvent) => void;

/** A null score renders as `—` (abstained/unmeasurable) so a base/cand pair always reads as two values. */
const fmtScore = (n: number | null): string => (n == null ? '—' : String(n));

// Pure, O(1): one human-readable line per event. Keep cheap (it runs synchronously on the fixer's stdout path).
export function renderOptimizeEvent(e: OptimizeEvent): string {
  switch (e.type) {
    case 'triaged':
      return `triaged: ${e.defectCount} defect(s) on the worklist`;
    case 'candidate-prepared':
      return `candidate-prepared [${e.node}] ${e.bucket} → ${e.candidateRef}`;
    case 'fixer-started':
      return `fixer-started [${e.node}] ${e.bucket}`;
    case 'fixer-trace':
      return `fixer-trace [${e.node}] ${JSON.stringify(e.payload)}`;
    case 'fixer-aborted':
      return `fixer-aborted [${e.node}] ${e.reason}`;
    case 'fixer-done':
      return `fixer-done [${e.node}] edits=${e.editsApplied} tokens=${e.tokensSpent}`;
    case 'scored':
      return `scored [${e.node}] base=${fmtScore(e.baseScore)} cand=${fmtScore(e.candidateScore)}`;
    case 'gated': {
      const marker = e.verdict.accept ? 'accept ✓' : 'reject ✗';
      // base/cand are folded in the verdict as `delta` (candidate − base); render it + the reason which carries
      // the literal base/candidate numbers (e.g. "no strict improvement (candidate 0 ≤ base 0)").
      return `gated [${e.node}] ${marker} delta=${fmtScore(e.verdict.delta)} (${e.verdict.reason})`;
    }
    case 'landed':
      return `landed [${e.node}] ${e.decision}`;
    case 'fix-cycle-ceiling':
      return `fix-cycle-ceiling [${e.node}] ${e.cycles}/${e.ceiling} — escalate`;
    case 'stopped':
      return `stopped: ${e.reason}`;
  }
}

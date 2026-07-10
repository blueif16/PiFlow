// optimize/substrate/events.ts — the LIVE progress surface for the M6 FIX phase (docs/specs/optimize-
// substrate-plan.md §M6.5). A DEDICATED sink for the substrate fix loop, distinct from optimize/events.ts's
// `OptimizeEvent` (the classic routing loop) — the two loops are separate systems (M2 header), so each gets
// its own typed stream rather than sharing one union. One variant per phase boundary of `fixIssue`
// /`adoptSubstrateManifest`; the driver emits one event per boundary, FIRE-AND-FORGET.
//
// `safeEmit` is a PRIVATE copy of the driver.ts:170 / loop.ts:88 try/catch pattern (NOT imported — those are
// module-private closures over a DIFFERENT event type; re-implementing the four lines keeps this module's
// stream fully independent). The stream is a PROJECTION, never load-bearing: a throwing sink is swallowed so
// it can never break the fix loop (the loop is the source of truth; the events only narrate it).

/** One phase boundary of the substrate fix loop. `issue` is the issue's pie NAME (the human-facing handle);
 *  each variant carries only the few fields its one-line render needs — never the whole Issue/manifest. */
export type SubstrateEvent =
  | { type: 'issue-activated'; issue: string; node: string }
  | { type: 'candidate-prepared'; issue: string; candidateRef: string; included: number; excluded: number }
  | { type: 'fixer-started'; issue: string }
  | { type: 'fixer-done'; issue: string; editsApplied: number }
  | { type: 'prove-started'; issue: string; childId: string }
  | { type: 'measured'; issue: string; sharedKeys: number }
  | { type: 'gated'; issue: string; accept: boolean; reason: string }
  | { type: 'staged'; issue: string; decision: 'staged' | 'discarded'; manifestPath: string }
  | { type: 'adopted'; issue: string; commit: string; files: number }
  | { type: 'stopped'; issue: string; reason: string }
  // RUN-LEVEL BLAME boundaries (docs/design/optimize-blame.md §4) — the same dedicated substrate stream, one
  // level up. Unlike the fix-loop variants above these carry NO `issue` (blame is run-scoped, not per-issue):
  // the measure fold, the judge round, and the one verify re-check each announce their boundary + count.
  | { type: 'blame-measured' }
  | { type: 'blame-judged'; blamed: number }
  | { type: 'blame-verified'; blamed: number };

export type SubstrateEventSink = (event: SubstrateEvent) => void;

/**
 * Fire-and-forget an event through `sink`. A throwing sink (e.g. a broken stdout) is SWALLOWED — the stream is
 * a projection, never a gate on the loop. `undefined` sink ⇒ a no-op. This is the driver.ts:170 pattern,
 * re-implemented locally on purpose (see the module header) — do NOT import optimize's private copy.
 */
export function safeEmit(sink: SubstrateEventSink | undefined, event: SubstrateEvent): void {
  if (!sink) return;
  try {
    sink(event);
  } catch {
    /* swallow — the stream never gates the loop */
  }
}

/** PURE, O(1): one human-readable line per event. Kept cheap (it runs synchronously on the fixer's path). */
export function renderSubstrateEvent(e: SubstrateEvent): string {
  switch (e.type) {
    case 'issue-activated':
      return `issue-activated [${e.issue}] node=${e.node} → active`;
    case 'candidate-prepared':
      return `candidate-prepared [${e.issue}] ${e.candidateRef} (included=${e.included}, oracle-excluded=${e.excluded})`;
    case 'fixer-started':
      return `fixer-started [${e.issue}]`;
    case 'fixer-done':
      return `fixer-done [${e.issue}] edits=${e.editsApplied}`;
    case 'prove-started':
      return `prove-started [${e.issue}] child=${e.childId} → verifying`;
    case 'measured':
      return `measured [${e.issue}] sharedGradedKeys=${e.sharedKeys}`;
    case 'gated': {
      const marker = e.accept ? 'accept ✓' : 'reject ✗';
      return `gated [${e.issue}] ${marker} (${e.reason})`;
    }
    case 'staged':
      return `staged [${e.issue}] ${e.decision} → ${e.manifestPath}`;
    case 'adopted':
      return `adopted [${e.issue}] commit=${e.commit} files=${e.files} → resolved`;
    case 'stopped':
      return `stopped [${e.issue}] ${e.reason}`;
    case 'blame-measured':
      return 'blame-measured — run-level hard measure folded';
    case 'blame-judged':
      return `blame-judged blamed=${e.blamed} → verifying`;
    case 'blame-verified':
      return `blame-verified blamed=${e.blamed}`;
  }
}

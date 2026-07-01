// derive.ts — the pure per-node DISPLAY derivation, computed ONCE in the observe surface so every view
// renders the SAME numbers from the SAME code. `buildRunView` stamps `deriveNode(node)` onto each
// RunViewNode.derived; a view (the GUI HUD today, the TUI later) then renders `node.derived.*` verbatim
// and NEVER re-derives a zone, ratio, ranking, or dedup on its own — that is how the two views stay in
// lockstep and thresholds live in exactly one place.
//
// These are the EXACT thresholds the GUI shipped inline (the porting oracle), lifted here unchanged:
//   • cache-hit  cacheRead/(input+cacheRead)  <0.3 high · <0.6 warn · else ok         (CacheDonut)
//   • tool-error errors/toolCalls             >0.15 high · >0.05 warn · else ok        (NodeHud)
//   • dominance  topTool/total               dominant iff ratio>0.8 AND toolCalls>5    (NodeHud)
//   • context    peak/window                 ≥0.7 high · ≥0.4 warn · else ok           (contextTone)
//   • time       durationMs/expectedMs        >1.5 high · >1 warn · else ok             (NodeModeStrip)
//   • retries    count                        ≥5 high · ≥1 warn · else ok               (NodeHud)
//
// This is the OBSERVE (display) layer: it computes EVERY zone a human view wants. The telemetry tier
// (telemetry.ts) is the separate agent-facing PICK — its anomaly triggers use different, stricter cutoffs
// (a display "warn" is not an agent-worklist item). The two are intentionally distinct lenses.

import { DEFAULT_CONTEXT_WINDOW } from './models.js';

/** An attention level, worst-first: `ok` < `warn` < `high`. A view maps it to its own colour vocabulary. */
export type Tone = 'ok' | 'warn' | 'high';

/** One tool in the ranked breakdown. `pct` is the tool's share of all calls (0–1). */
export interface RankedTool { name: string; count: number; pct: number }

/** One produced file in the unified output list. `path` is the display path; `ok` = on-disk verified. */
export interface DerivedOutput { path: string; bytes?: number; ok: boolean }

/** The per-node derived DISPLAY projection — zones + rankings + the unified output list, computed once. */
export interface NodeDerived {
  /** cache-hit rate `cacheRead/(input+cacheRead)` + tone; null when there is NO cache data (the GUI renders nothing). */
  cacheHit: { ratio: number; tone: Tone } | null;
  /** tool failures (`timeline` spans with `ok=false`) over tool calls; `rate` 0 (tone ok) when no tool calls. */
  toolError: { errors: number; rate: number; tone: Tone };
  /** the single most-used tool's share of all calls; `dominant` marks a probable stuck loop. */
  dominance: { tool: string | null; ratio: number; dominant: boolean };
  /** context peak over the model window (default window when unknown) + pressure tone; `frac` 0 when no peak. */
  context: { frac: number; tone: Tone };
  /** this run's duration over the cross-run mean + tone; null until the node has settled with a positive baseline. */
  time: { ratio: number; tone: Tone } | null;
  /** provider retries + tone (0 ok · 1–4 warn · ≥5 high). */
  retries: { count: number; tone: Tone };
  /** tools ranked by call count (descending), each with its share of all calls. */
  topTools: RankedTool[];
  /** unified produced files: declared artifacts ∪ writes not already covered by an artifact (dedup by display path). */
  outputs: DerivedOutput[];
}

/** The structural subset of a RunViewNode `deriveNode` reads. A RunViewNode satisfies it verbatim. */
export interface DeriveInput {
  tokens?: { input: number; cacheRead: number; contextPeak: number } | null;
  contextWindow?: number | null;
  durationMs?: number | null;
  expectedMs?: number | null;
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  timeline: { ok: boolean }[];
  retries: number;
  artifacts: { displayPath: string; bytes?: number; exists: boolean }[];
  writes: { displayPath: string; bytes?: number; verified: boolean }[];
}

// ── the zone cutoffs (the porting oracle) — each a pure scalar→Tone map, exported for live-view reuse ────
export const cacheTone = (ratio: number): Tone => (ratio < 0.3 ? 'high' : ratio < 0.6 ? 'warn' : 'ok');
export const toolErrorTone = (rate: number): Tone => (rate > 0.15 ? 'high' : rate > 0.05 ? 'warn' : 'ok');
/** Context-pressure zones: <40% ok · 40–70% warn · ≥70% high — quality degrades as the window fills. */
export const contextTone = (frac: number): Tone => (frac >= 0.7 ? 'high' : frac >= 0.4 ? 'warn' : 'ok');
/** Time-vs-mean zones: over the mean is warn, 50%+ over is high. */
export const timeTone = (ratio: number): Tone => (ratio > 1.5 ? 'high' : ratio > 1 ? 'warn' : 'ok');
export const retriesTone = (count: number): Tone => (count >= 5 ? 'high' : count >= 1 ? 'warn' : 'ok');

/** Compute a node's derived DISPLAY projection. Pure — the single source for every view's zones/rankings. */
export function deriveNode(n: DeriveInput): NodeDerived {
  // cache-hit: cacheRead / (input + cacheRead); null when there's no cache data at all.
  const input = n.tokens?.input ?? 0;
  const cacheRead = n.tokens?.cacheRead ?? 0;
  const cacheDenom = input + cacheRead;
  const cacheHit = cacheDenom === 0 ? null : { ratio: cacheRead / cacheDenom, tone: cacheTone(cacheRead / cacheDenom) };

  // tools: one total drives both the ranking share and the dominance ratio (sum of the breakdown, with the
  // NodeHud fallbacks so a divide never lands on 0).
  const entries = Object.entries(n.toolBreakdown);
  const total = entries.reduce((s, [, c]) => s + c, 0) || n.toolCalls || 1;
  const ranked = [...entries].sort((a, b) => b[1] - a[1]);
  const topTools: RankedTool[] = ranked.map(([name, count]) => ({ name, count, pct: count / total }));
  const top = ranked[0];
  const domRatio = top ? top[1] / total : 0;
  const dominance = { tool: top ? top[0] : null, ratio: domRatio, dominant: !!top && domRatio > 0.8 && n.toolCalls > 5 };

  // tool errors: failed timeline spans over tool calls.
  const errors = n.timeline.filter((s) => !s.ok).length;
  const errRate = n.toolCalls ? errors / n.toolCalls : 0;
  const toolError = { errors, rate: errRate, tone: toolErrorTone(errRate) };

  // context pressure: peak over the window (default window when the model's window is unknown).
  const peak = n.tokens?.contextPeak ?? 0;
  const win = n.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const ctxFrac = peak ? peak / win : 0;
  const context = { frac: ctxFrac, tone: contextTone(ctxFrac) };

  // time vs the cross-run mean — SETTLED nodes only (a running node has no final durationMs; the live
  // elapsed tick is a clock concern that stays in the view).
  const dur = n.durationMs ?? null;
  const avg = n.expectedMs ?? null;
  const time = dur != null && avg != null && avg > 0 ? { ratio: dur / avg, tone: timeTone(dur / avg) } : null;

  const retries = { count: n.retries, tone: retriesTone(n.retries) };

  // unified outputs: declared artifacts first (ok = on-disk exists), then any write a declared artifact
  // does not already cover (ok = verified) — the writes∪artifacts dedup the GUI repeated in three places.
  const arts = n.artifacts ?? [];
  const extraWrites = (n.writes ?? []).filter((w) => !arts.some((a) => a.displayPath === w.displayPath));
  const outputs: DerivedOutput[] = [
    ...arts.map((a) => ({ path: a.displayPath, bytes: a.bytes, ok: a.exists })),
    ...extraWrites.map((w) => ({ path: w.displayPath, bytes: w.bytes, ok: w.verified })),
  ];

  return { cacheHit, toolError, dominance, context, time, retries, topTools, outputs };
}

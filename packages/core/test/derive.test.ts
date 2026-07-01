// Tests for the pure per-node DISPLAY derivation (packages/core/src/observe/derive.ts). deriveNode is
// the ONE place the attention zones (cache-hit, tool-error, dominance, context, time, retries) + the
// ranked tool list + the unified output list are computed, so every view (GUI HUD now, TUI later) renders
// identical numbers from the identical code instead of re-deriving them. These are the EXACT thresholds the
// GUI shipped inline; each test pins a boundary so a shifted cutoff turns RED.
//
// Run: npx vitest run packages/core/test/derive.test.ts

import { describe, it, expect } from 'vitest';
import { deriveNode, type DeriveInput } from '../src/observe/derive.js';
import { DEFAULT_CONTEXT_WINDOW } from '../src/observe/models.js';

// Fill the required DeriveInput fields so a test states only what it cares about.
function di(p: Partial<DeriveInput> = {}): DeriveInput {
  return {
    toolCalls: 0,
    toolBreakdown: {},
    timeline: [],
    retries: 0,
    artifacts: [],
    writes: [],
    ...p,
  };
}
const tokens = (p: Partial<DeriveInput['tokens'] & object> = {}) => ({ input: 0, cacheRead: 0, contextPeak: 0, ...p });

describe('deriveNode — cache-hit zone (CacheDonut oracle: <0.3 high · <0.6 warn · else ok)', () => {
  it('is null when there is no cache data (denominator 0) — the GUI renders nothing', () => {
    expect(deriveNode(di()).cacheHit).toBeNull();
    expect(deriveNode(di({ tokens: tokens({ input: 0, cacheRead: 0 }) })).cacheHit).toBeNull();
  });
  it('ratio = cacheRead / (input + cacheRead)', () => {
    const d = deriveNode(di({ tokens: tokens({ input: 40, cacheRead: 60 }) }));
    expect(d.cacheHit!.ratio).toBeCloseTo(0.6, 10);
  });
  it('tones on the exact boundaries: <0.3 high, 0.3 warn, <0.6 warn, 0.6 ok', () => {
    const tone = (input: number, cacheRead: number) => deriveNode(di({ tokens: tokens({ input, cacheRead }) })).cacheHit!.tone;
    expect(tone(71, 29)).toBe('high'); // 0.29
    expect(tone(70, 30)).toBe('warn'); // 0.30 — NOT high
    expect(tone(41, 59)).toBe('warn'); // 0.59
    expect(tone(40, 60)).toBe('ok');   // 0.60 — NOT warn
  });
});

describe('deriveNode — tool-error zone (NodeHud oracle: >0.15 high · >0.05 warn · else ok)', () => {
  it('errors = timeline spans with ok=false; rate = errors / toolCalls', () => {
    const d = deriveNode(di({ toolCalls: 10, timeline: [{ ok: true }, { ok: false }, { ok: false }] }));
    expect(d.toolError.errors).toBe(2);
    expect(d.toolError.rate).toBeCloseTo(0.2, 10);
    expect(d.toolError.tone).toBe('high');
  });
  it('rate is 0 (tone ok) when there are no tool calls — no divide-by-zero', () => {
    const d = deriveNode(di({ toolCalls: 0, timeline: [{ ok: false }] }));
    expect(d.toolError.rate).toBe(0);
    expect(d.toolError.tone).toBe('ok');
  });
  it('tones on the exact boundaries: 0.15 warn (not high), 0.05 ok (not warn)', () => {
    const tone = (errors: number) => deriveNode(di({ toolCalls: 100, timeline: Array.from({ length: errors }, () => ({ ok: false })) })).toolError.tone;
    expect(tone(16)).toBe('high'); // 0.16
    expect(tone(15)).toBe('warn'); // 0.15 — NOT high
    expect(tone(6)).toBe('warn');  // 0.06
    expect(tone(5)).toBe('ok');    // 0.05 — NOT warn
  });
});

describe('deriveNode — tool dominance (NodeHud oracle: ratio>0.8 AND toolCalls>5)', () => {
  it('ratio = top tool count / total; flags dominant when >0.8 and toolCalls>5', () => {
    const d = deriveNode(di({ toolCalls: 10, toolBreakdown: { bash: 9, read: 1 } }));
    expect(d.dominance.tool).toBe('bash');
    expect(d.dominance.ratio).toBeCloseTo(0.9, 10);
    expect(d.dominance.dominant).toBe(true);
  });
  it('NOT dominant at exactly ratio 0.8 (needs strictly greater)', () => {
    const d = deriveNode(di({ toolCalls: 10, toolBreakdown: { bash: 8, read: 2 } }));
    expect(d.dominance.ratio).toBeCloseTo(0.8, 10);
    expect(d.dominance.dominant).toBe(false);
  });
  it('NOT dominant at toolCalls 5 even when one tool is 100% (needs >5)', () => {
    const d = deriveNode(di({ toolCalls: 5, toolBreakdown: { bash: 5 } }));
    expect(d.dominance.ratio).toBeCloseTo(1, 10);
    expect(d.dominance.dominant).toBe(false);
  });
  it('no tools → tool null, ratio 0, not dominant', () => {
    const d = deriveNode(di());
    expect(d.dominance).toEqual({ tool: null, ratio: 0, dominant: false });
  });
});

describe('deriveNode — context pressure (contextTone oracle: ≥0.7 high · ≥0.4 warn · else ok)', () => {
  it('frac = contextPeak / contextWindow', () => {
    const d = deriveNode(di({ tokens: tokens({ contextPeak: 50_000 }), contextWindow: 100_000 }));
    expect(d.context.frac).toBeCloseTo(0.5, 10);
    expect(d.context.tone).toBe('warn');
  });
  it('tones on the exact boundaries: 0.7 high, 0.4 warn', () => {
    const tone = (peak: number) => deriveNode(di({ tokens: tokens({ contextPeak: peak }), contextWindow: 100_000 })).context.tone;
    expect(tone(70_000)).toBe('high'); // 0.70 — inclusive
    expect(tone(69_999)).toBe('warn');
    expect(tone(40_000)).toBe('warn'); // 0.40 — inclusive
    expect(tone(39_999)).toBe('ok');
  });
  it('falls back to DEFAULT_CONTEXT_WINDOW when the window is unknown (null)', () => {
    const d = deriveNode(di({ tokens: tokens({ contextPeak: DEFAULT_CONTEXT_WINDOW / 2 }), contextWindow: null }));
    expect(d.context.frac).toBeCloseTo(0.5, 10);
  });
  it('frac is 0 (tone ok) when there is no context peak', () => {
    const d = deriveNode(di({ contextWindow: 100_000 }));
    expect(d.context.frac).toBe(0);
    expect(d.context.tone).toBe('ok');
  });
});

describe('deriveNode — time vs cross-run mean (NodeModeStrip oracle: >1.5 high · >1 warn · else ok)', () => {
  it('null until the node has a settled duration AND a positive baseline', () => {
    expect(deriveNode(di({ durationMs: null, expectedMs: 1000 })).time).toBeNull();
    expect(deriveNode(di({ durationMs: 1000, expectedMs: null })).time).toBeNull();
    expect(deriveNode(di({ durationMs: 1000, expectedMs: 0 })).time).toBeNull();
  });
  it('ratio = durationMs / expectedMs', () => {
    const d = deriveNode(di({ durationMs: 3000, expectedMs: 1000 }));
    expect(d.time!.ratio).toBeCloseTo(3, 10);
    expect(d.time!.tone).toBe('high');
  });
  it('tones on the exact boundaries: 1.5 warn (not high), 1.0 ok (not warn)', () => {
    const tone = (dur: number) => deriveNode(di({ durationMs: dur, expectedMs: 1000 })).time!.tone;
    expect(tone(1600)).toBe('high'); // 1.6
    expect(tone(1500)).toBe('warn'); // 1.5 — NOT high
    expect(tone(1100)).toBe('warn'); // 1.1
    expect(tone(1000)).toBe('ok');   // 1.0 — NOT warn
    expect(tone(900)).toBe('ok');    // 0.9
  });
});

describe('deriveNode — retries zone (NodeHud oracle: ≥5 high · ≥1 warn · else ok)', () => {
  it('tones on the exact boundaries', () => {
    expect(deriveNode(di({ retries: 0 })).retries).toEqual({ count: 0, tone: 'ok' });
    expect(deriveNode(di({ retries: 1 })).retries).toEqual({ count: 1, tone: 'warn' });
    expect(deriveNode(di({ retries: 4 })).retries).toEqual({ count: 4, tone: 'warn' });
    expect(deriveNode(di({ retries: 5 })).retries).toEqual({ count: 5, tone: 'high' });
  });
});

describe('deriveNode — ranked topTools (ToolStackBar oracle: sort desc, pct = share of calls)', () => {
  it('ranks tools by call count descending with each tool\'s share', () => {
    const d = deriveNode(di({ toolCalls: 10, toolBreakdown: { bash: 3, read: 5, edit: 2 } }));
    expect(d.topTools).toEqual([
      { name: 'read', count: 5, pct: 0.5 },
      { name: 'bash', count: 3, pct: 0.3 },
      { name: 'edit', count: 2, pct: 0.2 },
    ]);
  });
  it('is empty when no tools ran', () => {
    expect(deriveNode(di()).topTools).toEqual([]);
  });
});

describe('deriveNode — unified outputs (artifacts ∪ writes, dedup by displayPath)', () => {
  it('artifacts first (ok=exists), then writes NOT already covered by an artifact (ok=verified)', () => {
    const d = deriveNode(di({
      artifacts: [{ displayPath: 'out/a.txt', bytes: 10, exists: true }],
      writes: [
        { displayPath: 'out/a.txt', bytes: 10, verified: true }, // deduped — an artifact already covers it
        { displayPath: 'out/b.txt', bytes: 5, verified: false },
      ],
    }));
    expect(d.outputs).toEqual([
      { path: 'out/a.txt', bytes: 10, ok: true },
      { path: 'out/b.txt', bytes: 5, ok: false },
    ]);
  });
  it('is empty when the node produced nothing', () => {
    expect(deriveNode(di()).outputs).toEqual([]);
  });
});

// Tests for the extracted `nodeTokenSpine` + `assembleNode` (packages/core/src/observe/runView.ts) — the
// two pure functions the batch builder AND the live SSE fold will share so both compute a byte-identical
// per-node RunViewNode. These pin the P0a extraction's mutation-checkable acceptance:
//   • the rec.usage-vs-event-replay PRECEDENCE — drop the usage branch (always use rich) → a Claude
//     fixture (blank event replay, real usage) turns RED.
//   • assembleNode produces the same node fields the buildRunView loop did (tokens/spine/derived stamp).
//
// Run: npx vitest run packages/core/test/node-token-spine.test.ts

import { describe, it, expect } from 'vitest';
import { nodeTokenSpine, assembleNode, type AssembleNodeCtx, type NodeIoLedger } from '../src/observe/runView.js';
import { createNodeAccumulator, type RichNode } from '../src/observe/distill.js';
import { loadModelCatalog } from '../src/observe/models.js';
import type { NodeUsage } from '../src/runner/status.js';
import type { PiEvent } from '../src/runner/events.js';

const catalog = loadModelCatalog();

/** A BLANK rich node — what a Claude node's (opaque-to-pi) event replay produces: all-zero, no model. */
function blankRich(): RichNode {
  return createNodeAccumulator().finalize().rich;
}
/** A populated rich node from a pi-style event stream (model + real usage on message_end). */
function piRich(events: PiEvent[]): RichNode {
  const acc = createNodeAccumulator();
  for (const e of events) acc.push(e);
  return acc.finalize().rich;
}

describe('nodeTokenSpine — rec.usage-first-vs-event-replay precedence', () => {
  // THE Claude case: the event replay is BLANK (rich.tokens all zero, rich.model null), the authoritative
  // rollup lives on rec.usage. The spine MUST source from usage. Mutation: if nodeTokenSpine drops the
  // `usage` branch and always returns rich, every one of these turns red (0 instead of the usage values).
  it('sources tokens/cost/context/turns from rec.usage when present (Claude — blank replay)', () => {
    const usage: NodeUsage = {
      inputTokens: 18, outputTokens: 337, cacheRead: 17172, cacheCreation: 4790,
      cost: 0.0130002, contextWindow: 200000, numTurns: 2, stopReason: 'end_turn',
    };
    const spine = nodeTokenSpine(usage, blankRich(), catalog, 'claude-haiku-4-5-20251001');

    expect(spine.tokens.input).toBe(18);
    expect(spine.tokens.output).toBe(337);
    expect(spine.tokens.cacheRead).toBe(17172);
    expect(spine.tokens.cacheWrite).toBe(4790); // Claude cache_creation ≙ pi cacheWrite
    expect(spine.tokens.cost).toBeCloseTo(0.0130002, 6);
    expect(spine.tokens.contextPeak).toBe(18 + 17172 + 4790); // 21980 — context that was in the window
    expect(spine.tokens.billable).toBe(18 + 337);
    expect(spine.contextWindow).toBe(200000); // usage's own cap, not the registry default
    expect(spine.model).toBe('claude-haiku-4-5-20251001'); // effModel, since replay carried none
    expect(spine.modelCalls).toBe(2); // num_turns — the real invocation count, not rich's 0
    expect(spine.stopReason).toBe('end_turn');
    expect(spine.truncated).toBe(false);
  });

  // The pi case: NO rec.usage → the override never fires, the spine is the event replay verbatim.
  it('sources from the event replay when rec.usage is absent (pi — override never fires)', () => {
    const rich = piRich([
      { type: 'message_start', message: { role: 'assistant', model: 'm1', provider: 'cp' } },
      { type: 'message_end', message: { role: 'assistant', usage: { input: 100, output: 20, cost: 0.5, totalTokens: 120 }, stopReason: 'end_turn' } },
    ]);
    const spine = nodeTokenSpine(undefined, rich, catalog, 'm1');

    expect(spine.tokens.input).toBe(100);
    expect(spine.tokens.output).toBe(20);
    expect(spine.tokens.cost).toBeCloseTo(0.5, 6);
    expect(spine.tokens.contextPeak).toBe(120);
    expect(spine.tokens.billable).toBe(120);
    expect(spine.model).toBe('m1'); // rich.model, not effModel
    expect(spine.modelCalls).toBe(1);
    expect(spine.truncated).toBe(false);
  });

  // truncation flows from the usage stopReason when usage is present (token-cap cutoff).
  it('flags truncated from a usage stopReason of max_tokens', () => {
    const usage: NodeUsage = { inputTokens: 10, outputTokens: 8000, cost: 0.2, contextWindow: 200000, numTurns: 1, stopReason: 'max_tokens' };
    const spine = nodeTokenSpine(usage, blankRich(), catalog, 'claude-haiku-4-5-20251001');
    expect(spine.stopReason).toBe('max_tokens');
    expect(spine.truncated).toBe(true);
  });
});

describe('assembleNode — builds the RunViewNode (spine + derived stamp)', () => {
  // a minimal ctx: identity abs/display, no history, no checkpoints — enough to prove the wiring.
  const ctx: AssembleNodeCtx = {
    toAbs: (p) => (p.startsWith('/') ? p : `/run/${p}`),
    underRun: (abs) => abs.startsWith('/run/'),
    displayPath: (abs) => String(abs).replace(/^.*\//, ''),
    catalog,
    expected: {},
    samples: {},
    ckJournal: {},
    readMarkerSync: () => null,
  };

  it('stamps the rec.usage spine and the derived display projection onto the node', () => {
    const rec = {
      id: 'cx', label: 'Claude Node', status: 'ok' as const,
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 18, outputTokens: 337, cacheRead: 17172, cacheCreation: 4790, cost: 0.0130002, contextWindow: 200000, numTurns: 2, stopReason: 'end_turn' } as NodeUsage,
      artifacts: [{ path: 'out.txt', exists: true, bytes: 5 }],
      issues: [],
    };
    const io: NodeIoLedger = { phase: 'author', reads: [], writes: ['out.txt'] };
    const node = assembleNode(rec, blankRich(), io, ctx);

    expect(node.id).toBe('cx');
    expect(node.phase).toBe('author'); // io.json phase override
    expect(node.tokens?.billable).toBe(18 + 337); // spine tokens
    expect(node.contextWindow).toBe(200000);
    expect(node.modelCalls).toBe(2);
    // the DERIVED display projection is stamped (computed once here, never re-derived by a view).
    expect(node.derived).toBeTruthy();
    expect(node.derived!.context.frac).toBeCloseTo(21980 / 200000, 4);
    // the declared artifact appears in the unified outputs.
    expect(node.derived!.outputs.some((o) => o.path === 'out.txt' && o.ok)).toBe(true);
  });

  // ── Defect F2 — expectedMs no longer self-falls-back to the node's OWN durationMs. Before the fix,
  // `ctx.expected[id] ?? rec.durationMs ?? null` meant a node with ZERO cross-run history got its expectedMs
  // pinned to ITS OWN duration, fabricating a `derived.time.ratio` of EXACTLY 1.0 ("on-target") — a lie, not
  // an honest "no baseline". The honest value is null.
  it('(F2) expectedMs is null (not the node\'s own durationMs) when there is NO cross-run history', () => {
    const rec = { id: 'x', label: 'X', status: 'ok' as const, durationMs: 12345, artifacts: [], issues: [] };
    const node = assembleNode(rec, blankRich(), null, ctx); // ctx.expected = {} — no history
    expect(node.expectedMs).toBeNull();
    // and the fabricated on-target ratio is gone with it — no live tone without a real baseline.
    expect(node.derived!.time).toBeNull();
  });

  it('(F2 regression guard) expectedMs still reports the REAL cross-run mean when history exists', () => {
    const ctxWithHistory: AssembleNodeCtx = { ...ctx, expected: { x: 5000 }, samples: { x: 3 } };
    const rec = { id: 'x', label: 'X', status: 'ok' as const, durationMs: 12345, artifacts: [], issues: [] };
    const node = assembleNode(rec, blankRich(), null, ctxWithHistory);
    expect(node.expectedMs).toBe(5000); // the honest cross-run mean, NOT durationMs
    expect(node.priorSamples).toBe(3);
    expect(node.derived!.time).not.toBeNull();
    expect(node.derived!.time!.ratio).toBeCloseTo(12345 / 5000, 6);
  });

  // ── Defect F1+F2 combined, at the assembleNode seam — the EXACT end-to-end shape of the reported bug:
  // a REUSED node (carries a stale prior-run durationMs) with a REAL cross-run baseline still must not paint
  // a live time tone (status gate wins), even though expectedMs itself is now honest (F2 sources the real
  // mean, not a self-fallback).
  it('(F1+F2) a REUSED node with real cross-run history reports the honest expectedMs but NO derived.time tone', () => {
    const ctxWithHistory: AssembleNodeCtx = { ...ctx, expected: { gameplay: 536000 }, samples: { gameplay: 4 } };
    const rec = { id: 'gameplay', label: 'Gameplay', status: 'reused' as const, durationMs: 914045, artifacts: [], issues: [] };
    const node = assembleNode(rec, blankRich(), null, ctxWithHistory);
    expect(node.expectedMs).toBe(536000); // honest — the real cross-run mean, not self-fallback
    expect(node.status).toBe('reused');
    expect(node.derived!.time).toBeNull(); // the status gate — no fabricated tone for a cache-hit node
  });

  it('a pending checkpoint marker flips the shown status to awaiting-input', () => {
    const ctxCk: AssembleNodeCtx = {
      ...ctx,
      readMarkerSync: (id) => (id === 'q0' ? { nodeId: 'q0', label: 'Gate', kind: 'confirm', prompt: 'proceed?', askedAt: '2026-07-01T00:00:00.000Z', hash: 'h1' } as never : null),
    };
    const rec = { id: 'q0', label: 'Gate', status: 'pending' as const, artifacts: [], issues: [] };
    const node = assembleNode(rec, blankRich(), null, ctxCk);
    expect(node.status).toBe('awaiting-input');
    expect(node.checkpoint?.status).toBe('pending');
  });
});

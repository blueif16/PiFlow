import { describe, it, expect } from 'vitest';
import { resolveNodeWriteScope } from '../src/runner/node-lifecycle.js';
import type { NodeSpec } from '../src/types.js';
import type { ResolveCtx } from '../src/workflow/resolver.js';

// ─────────────────────────────────────────────────────────────────────────────
// resolveNodeWriteScope — the EXTRACTED write-scope resolve (node-lifecycle.ts, previously inlined at the
// `sandbox.write: resolveAll(...)` call site). `runNode` calls this same helper (byte-equal behavior,
// regression-guarded by runner.test's "U7-IO" DRIVER-OWNS marker assertions); it is exported so a caller
// OUTSIDE the node lifecycle — `spawnChildRun`'s replay-from-node-start reset (M1.4) — can compute the
// SAME resolved owned-paths set without re-deriving the resolve inline.
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal dense NodeSpec carrying only what resolveNodeWriteScope reads (sandbox.write). */
function nodeWithWrite(write: string[]): NodeSpec {
  return {
    id: 'n',
    label: 'n',
    tools: {},
    io: { reads: [], produces: [], externalInputs: [], dependsOn: [], artifacts: [] },
    sandbox: { provider: 'local', workspace: '.', read: [], write, output: 'out/n' },
  } as unknown as NodeSpec;
}

const ctx = (over: Partial<ResolveCtx> = {}): ResolveCtx => ({ run: '/runs/abc', workspace: '/canon', ...over });

describe('resolveNodeWriteScope — sandbox.write (contract.owns) token-resolved', () => {
  it('resolves {{RUN}}/{{WORKSPACE}} tokens in every owns entry', () => {
    const node = nodeWithWrite(['{{RUN}}/out/final.txt', '{{WORKSPACE}}/data/final.txt']);
    expect(resolveNodeWriteScope(node, ctx())).toEqual(['/runs/abc/out/final.txt', '/canon/data/final.txt']);
  });

  it('leaves a token-free entry untouched (a plain relative owns path)', () => {
    const node = nodeWithWrite(['final.txt', 'spec/answer.md']);
    expect(resolveNodeWriteScope(node, ctx())).toEqual(['final.txt', 'spec/answer.md']);
  });

  it('an EMPTY owns list resolves to an empty list (a node that owns nothing)', () => {
    expect(resolveNodeWriteScope(nodeWithWrite([]), ctx())).toEqual([]);
  });

  it('is PURE — does not mutate the node it was handed', () => {
    const node = nodeWithWrite(['{{RUN}}/x.txt']);
    const before = [...node.sandbox.write];
    resolveNodeWriteScope(node, ctx());
    expect(node.sandbox.write).toEqual(before);
  });
});

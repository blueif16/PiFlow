import { describe, it, expect } from 'vitest';
import { assessRunView, type RunView, type RunViewNode } from '@piflow/core';

// L0 COMPOSITE GUARD for the honest control-VM smoke (docs/design/full-run-e2e-LOCKED.md, Target 1).
// The live smoke driver (deploy/control-vm/smoke-live.mjs, L3 nightly) PASSes iff
// `assessRunView(view,{expectNodes:['greet']}).pass` AND an independent HTTP byte-probe both hold. This file
// is the pure, free (every-push) unit that pins the `assessRunView` half of that composite so a broken smoke
// can't silently green: it fixtures the EXACT run-view shape the deployed plane's greet node must yield
// (sandbox 'e2b', run done+ok, one greet node status 'ok', one artifact at out/greet/greeting.txt present +
// non-empty — the path that agrees with Target 3's contract and the smoke's `?path=` probe), then asserts the
// rubric verdict. The two injected-fault companions run against PRODUCTION assess.ts (no test-option flip):
// each reds ONLY if a real assess.ts check (the artifact-existence gate / the inmemory forbid gate) is deleted.

// A MINIMAL-but-valid RunViewNode — only the rubric-relevant fields carry meaning; the rest are zeroed to the
// shape buildRunView emits. `over` overrides the fields under test.
function mkNode(over: Partial<RunViewNode> & { id: string }): RunViewNode {
  return {
    label: over.id, phase: null, status: 'ok',
    toolCalls: 0, toolBreakdown: {}, timeline: [], reads: [], scopes: [], writes: [],
    artifacts: [], bash: [], retries: 0, stopReason: null, truncated: false,
    thinkingChars: 0, modelCalls: 0, maxToolRepeat: 0, repeatedTool: null,
    ...over,
  };
}

// The fixture the honest smoke's greet node must produce on the deployed (e2b-backed) plane. Overridable only
// on the fault-relevant fields (`sandbox`, and the single greet artifact's `exists`).
function mkGreetView(over: { sandbox?: RunView['sandbox']; artifactExists?: boolean } = {}): RunView {
  return {
    run: 'control-vm-0001',
    sandbox: over.sandbox ?? 'e2b',
    done: true,
    ok: true,
    totals: { nodes: 1, ok: 1, failed: 0 },
    stages: [],
    edges: [],
    nodes: [
      mkNode({
        id: 'greet',
        status: 'ok',
        artifacts: [{
          path: '/run/out/greet/greeting.txt',
          displayPath: 'out/greet/greeting.txt',
          exists: over.artifactExists ?? true,
          bytes: 13, // len('CONTROL-VM-OK')
        }],
      }),
    ],
  };
}

describe('assess-probe — L0 composite guard for the honest control-VM smoke', () => {
  it('PASSES the deployed-plane greet shape (e2b, done+ok, greet ok, out/greet/greeting.txt present + non-empty)', () => {
    const r = assessRunView(mkGreetView(), { expectNodes: ['greet'] });
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  // Injected fault (a) — RED against PRODUCTION assess.ts: with everything else self-reporting success, flip
  // ONLY the on-disk artifact to absent. The rubric must still fail, naming out/greet/greeting.txt. This reds
  // ONLY because assess.ts:72 reads `a.exists`; deleting that check would also green this standing case.
  it('FAILS when the greet artifact is absent on disk, naming out/greet/greeting.txt (the artifact gate)', () => {
    const r = assessRunView(mkGreetView({ artifactExists: false }), { expectNodes: ['greet'] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/out\/greet\/greeting\.txt/);
  });

  // Injected fault (b) — RED against PRODUCTION assess.ts: the run genuinely produced the artifact, but the
  // backend is inmemory (the Railway false-green N-inmemory). The rubric must fail, mentioning inmemory. This
  // reds ONLY because assess.ts:43 forbids inmemory by default; deleting that push would green this case.
  it('FAILS an inmemory backend even with the artifact present (the non-proving-sandbox gate)', () => {
    const r = assessRunView(mkGreetView({ sandbox: 'inmemory' }), { expectNodes: ['greet'] });
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/inmemory/);
  });
});

// (M6 · OQ5) CAPABILITY-PRESERVATION SUITE — the NEW op[] envelope is a STRICT SUPERSET of the OLD grammar.
//
// One DISCRIMINATING test per preserved capability: each asserts a SPECIFIC behavior that FAILS if that
// capability regresses (test-discipline (d)), NOT a vacuous "it runs". Together they pin that a node
// authoring the OLD keys (hooks/checks/policy) lowers to the identical op[] AND that each executor's
// load-bearing edge case is intact. The capabilities (per the M6 acceptance bar):
//   1. merge.run → status        (a non-zero run exit is observable, lowered with its onFailure)
//   2. promote reducers          (arrays-REPLACE under set/deepMerge; set-conflict across parallel ⇒ HALT)
//   3. seed idempotency          (a filled dest is NOT re-staged — a resume never clobbers)
//   4. checks ⊥ policy           (flipping onFailure leaves the gate kind/path/param byte-identical)
//   5. when:on-failure           (an on-failure op lowers/carries its lane verbatim)
//   6. union dedup               (first-occurrence-wins across two refs)
//   7. parallel-fold all-present (same-target concurrent folds keep every fragment — #13)
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyReducer } from '../src/workflow/state.js';
import { barrierMerge, ConflictError, type NodeUpdate } from '../src/workflow/ops/promote.js';
import { stageSeed } from '../src/workflow/ops/seed.js';
import { applyProjectionOp, applyMergeOp } from '../src/index.js';
import { lowerToOps } from '../src/workflow/template/lower.js';
import type { TemplateNode } from '../src/workflow/template/types.js';

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});
const mkTmp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-cap-'));

// A minimal authored TemplateNode (only the fields the lowering reads). The contract is unused by lowerToOps.
function tnode(over: Partial<TemplateNode>): TemplateNode {
  return {
    id: 'x', phase: 'p', deps: [], prompt: { file: 'prompt.md' },
    contract: { artifacts: [], owns: [], readScope: [] },
    ...over,
  } as TemplateNode;
}

// ── 1. merge.run → status ───────────────────────────────────────────────────────────────────────────
describe('capability: merge.run exit routes to status (#18 preserved)', () => {
  it('a non-zero `run` op exit is reported failed:true (the swallowed-exit regression stays caught)', async () => {
    tmp = await mkTmp();
    const r = await applyMergeOp({ run: { cmd: 'false' } }, tmp); // `false` exits 1
    expect(r.op).toBe('run');
    expect(r.failed).toBe(true); // if this regressed to swallow the exit, the node could never block on it
    expect(r.exit).not.toBe(0);
  });

  it('an authored hooks.merge with a run op lowers to a merge transform op (the SLOT that carries onFailure)', () => {
    const ops = lowerToOps(tnode({ hooks: { merge: { ops: [{ run: { cmd: 'scripts/gen.sh' } }] } } }))!;
    const mergeOp = ops.find((o) => o.transform?.kind === 'merge');
    expect(mergeOp).toBeDefined();
    expect((mergeOp!.transform as { ops: unknown[] }).ops).toEqual([{ run: { cmd: 'scripts/gen.sh' } }]);
  });
});

// ── 2. promote reducers: arrays-REPLACE + set-conflict ⇒ HALT ─────────────────────────────────────────
describe('capability: promote reducers (arrays-REPLACE + set-conflict ⇒ HALT)', () => {
  it("'set' REPLACES an array wholesale (arrays are leaves — use append to concat)", () => {
    expect(applyReducer([1, 2, 3], [9], 'set')).toEqual([9]); // not [1,2,3,9]
  });

  it("'deepMerge' REPLACES a nested array (documented arrays-as-leaves policy), keeping sibling keys", () => {
    const out = applyReducer({ a: [1, 2], keep: 'x' }, { a: [9] }, 'deepMerge') as Record<string, unknown>;
    expect(out.a).toEqual([9]); // the array is REPLACED, not concatenated
    expect(out.keep).toBe('x'); // the untouched sibling survives
  });

  it("'append' is the OPT-IN concat (the contrast that proves set/deepMerge REPLACE, not concat)", () => {
    expect(applyReducer([1, 2], [3], 'append')).toEqual([1, 2, 3]);
  });

  it('two PARALLEL nodes writing the SAME `set` channel HALT with a ConflictError (LangGraph InvalidUpdate)', () => {
    const updates: NodeUpdate[] = [
      { nodeId: 'a', promotes: [{ to: 'verdict', value: 1, merge: 'set' }] },
      { nodeId: 'b', promotes: [{ to: 'verdict', value: 2, merge: 'set' }] },
    ];
    expect(() => barrierMerge({}, updates)).toThrow(ConflictError);
  });

  it('the SAME channel from two parallel nodes under `append` is ALLOWED (a declared concurrent reducer)', () => {
    const updates: NodeUpdate[] = [
      { nodeId: 'a', promotes: [{ to: 'log', value: ['a'], merge: 'append' }] },
      { nodeId: 'b', promotes: [{ to: 'log', value: ['b'], merge: 'append' }] },
    ];
    expect(barrierMerge({}, updates)).toEqual({ log: ['a', 'b'] }); // no throw; deterministic node order
  });
});

// ── 3. seed idempotency / skip-if-filled ──────────────────────────────────────────────────────────────
describe('capability: seed idempotency (a filled dest is NOT re-staged — resume never clobbers)', () => {
  it('does NOT overwrite an already-filled FILE dest (the resume-safety invariant)', async () => {
    tmp = await mkTmp();
    const workspace = await mkTmp();
    await fs.writeFile(path.join(workspace, 'tpl.json'), '{"src":"NEW"}');
    // The dest already exists with content → a re-stage must SKIP it (idempotent).
    await fs.mkdir(path.join(tmp, 'spec'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'spec', 'skeleton.json'), '{"existing":"KEEP"}');
    const res = await stageSeed(
      { to: 'spec/skeleton.json', from: path.join(workspace, 'tpl.json') },
      { run: tmp, workspace } as never,
      tmp,
    );
    expect(res.staged).toBe(false); // skipped — the filled dest is left intact
    expect(await fs.readFile(path.join(tmp, 'spec', 'skeleton.json'), 'utf8')).toBe('{"existing":"KEEP"}');
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('DOES stage when the dest is absent (the skip-if-filled gate does not over-reach to empty dests)', async () => {
    tmp = await mkTmp();
    const workspace = await mkTmp();
    await fs.writeFile(path.join(workspace, 'tpl.json'), '{"src":"FRESH"}');
    const res = await stageSeed(
      { to: 'spec/skeleton.json', from: path.join(workspace, 'tpl.json') },
      { run: tmp, workspace } as never,
      tmp,
    );
    expect(res.staged).toBe(true);
    expect(await fs.readFile(path.join(tmp, 'spec', 'skeleton.json'), 'utf8')).toBe('{"src":"FRESH"}');
    await fs.rm(workspace, { recursive: true, force: true });
  });
});

// ── 4. checks ⊥ policy: flip onFailure WITHOUT touching the gate ───────────────────────────────────────
describe('capability: checks ⊥ policy split (flip onFailure, gate untouched)', () => {
  it('policy.fail block→warn flips ONLY onFailure; the lowered gate (kind/path/param) is byte-identical', () => {
    const check = { kind: 'fenced-tail', path: 'out.json', param: { minItems: 3 } };
    const blockOps = lowerToOps(tnode({ checks: { post: [check] }, policy: { fail: 'block' } }))!;
    const warnOps = lowerToOps(tnode({ checks: { post: [check] }, policy: { fail: 'warn' } }))!;
    const blockGate = blockOps.find((o) => o.gate)!;
    const warnGate = warnOps.find((o) => o.gate)!;
    // The CONSEQUENCE flipped…
    expect(blockGate.onFailure).toBe('block');
    expect(warnGate.onFailure).toBe('warn');
    // …but the DETECTION (the gate) is byte-identical — the detection ⊥ consequence split holds.
    expect(warnGate.gate).toEqual(blockGate.gate);
    expect(blockGate.gate).toEqual({ kind: 'fenced-tail', path: 'out.json', param: { minItems: 3 } });
  });

  it('a `warn`-SEVERITY check warns regardless of policy.fail (severity wins for that check)', () => {
    const ops = lowerToOps(
      tnode({ checks: { post: [{ kind: 'k', severity: 'warn' }] }, policy: { fail: 'block' } }),
    )!;
    expect(ops.find((o) => o.gate)!.onFailure).toBe('warn');
  });
});

// ── 5. when:on-failure ────────────────────────────────────────────────────────────────────────────────
describe('capability: when:on-failure lane (carried verbatim through the envelope)', () => {
  it('a directly-authored on-failure op is carried verbatim (the lane is not flattened to post)', () => {
    const node = tnode({
      op: [{ when: 'on-failure', run: { cmd: 'scripts/rollback.sh' } }],
    });
    const ops = lowerToOps(node)!;
    expect(ops).toHaveLength(1);
    expect(ops[0].when).toBe('on-failure'); // NOT rewritten to 'post' — the compensate lane survives
    expect(ops[0].run).toEqual({ cmd: 'scripts/rollback.sh' });
  });

  it('a pre-gate lowers to the `pre` lane, NOT post (the #11 firing-side distinction is preserved)', () => {
    const ops = lowerToOps(tnode({ checks: { pre: [{ kind: 'json-parses', path: 'in.json' }] } }))!;
    const preGate = ops.find((o) => o.gate)!;
    expect(preGate.when).toBe('pre'); // a pre-check is a PRE gate, not flattened to post
  });
});

// ── 6. union dedup ────────────────────────────────────────────────────────────────────────────────────
describe('capability: union dedup (first occurrence wins across refs)', () => {
  it('a slot present in BOTH refs appears exactly ONCE (first occurrence wins)', async () => {
    tmp = await mkTmp();
    const spec = {
      meta: { archetype: 'demo' },
      assetList: [{ slot: 'hero', type: 'sprite' }],
      entities: [{ assetSlot: 'hero' }, { assetSlot: 'coin', type: 'sprite' }], // hero dup ⇒ dropped
    };
    const res = await applyProjectionOp(
      'index',
      {
        to: 'index.json',
        union: { key: 'slot', carry: ['type'], itemsKey: 'slots', from: ['assetList', 'entities[].assetSlot'] },
      },
      spec,
      tmp,
    );
    expect(res.rows).toBe(2); // hero counted ONCE + coin — not 3
    const out = (await fs.readFile(path.join(tmp, 'index.json'), 'utf8').then(JSON.parse)) as {
      slots: { slot: string }[];
    };
    expect(out.slots.map((s) => s.slot)).toEqual(['hero', 'coin']);
  });
});

// ── 7. parallel-fold all-fragments-present (#13) ──────────────────────────────────────────────────────
describe('capability: parallel same-target folds keep every fragment (#13)', () => {
  it('3 concurrent folds into one file → all 3 fragments survive (no lost update)', async () => {
    tmp = await mkTmp();
    await fs.mkdir(path.join(tmp, 'spec'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'spec', 'bp.json'), '{}');
    const ids = ['a', 'b', 'c'];
    for (const id of ids) await fs.writeFile(path.join(tmp, 'spec', `${id}.json`), `{"by":"${id}"}`);
    await Promise.all(
      ids.map((id) =>
        applyMergeOp({ fold: { from: `spec/${id}.json`, to: 'spec/bp.json', into: id } }, tmp as string),
      ),
    );
    const bp = JSON.parse(await fs.readFile(path.join(tmp, 'spec', 'bp.json'), 'utf8'));
    expect(bp).toEqual({ a: { by: 'a' }, b: { by: 'b' }, c: { by: 'c' } });
  });
});

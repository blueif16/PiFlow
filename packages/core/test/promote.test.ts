// U7 — the `promote` POST-op (lift a node output into a RunState channel via the channel reducer) + the
// stage-barrier merge (apply parallel nodes' promotes serially+deterministically into .pi/state.json; a
// `set` channel with two concurrent writers is a flagged conflict — LangGraph InvalidUpdateError semantics).
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parsePromote,
  extractPromoteValue,
  applyPromotes,
  barrierMerge,
  ConflictError,
} from '../src/index.js';
import type { PromoteSpec, RunState } from '../src/index.js';

let tmp: string | undefined;
afterEach(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  tmp = undefined;
});

const mkTmp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-promote-'));
const writeJson = async (p: string, o: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');
};

// ---------- parsePromote (the spec parse) ----------
describe('parsePromote — the from/to/merge spec', () => {
  it('parses an artifact:field source (default merge = set)', () => {
    expect(parsePromote({ from: 'spec/classification.json:archetype', to: 'archetype' })).toEqual({
      from: 'spec/classification.json:archetype',
      to: 'archetype',
      merge: 'set',
    });
  });

  it('carries an explicit reducer through', () => {
    expect(parsePromote({ from: '@return:items', to: 'log', merge: 'append' }).merge).toBe('append');
  });
});

// ---------- extractPromoteValue (lift the value) ----------
describe('extractPromoteValue — lift from a produced file OR the @return', () => {
  it('lifts a dotted field from a produced artifact under {{RUN}}', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'spec', 'classification.json'), {
      archetype: 'platformer',
      genres: [{ id: 'g1' }],
    });
    const spec: PromoteSpec = { from: 'spec/classification.json:archetype', to: 'archetype', merge: 'set' };
    expect(await extractPromoteValue(spec, { run: tmp })).toBe('platformer');
    const spec2: PromoteSpec = { from: 'spec/classification.json:genres.0.id', to: 'g', merge: 'set' };
    expect(await extractPromoteValue(spec2, { run: tmp })).toBe('g1');
  });

  it('lifts a field from the @return structured value', async () => {
    tmp = await mkTmp();
    const spec: PromoteSpec = { from: '@return:milestones', to: 'milestones', merge: 'set' };
    const value = await extractPromoteValue(spec, { run: tmp, returnValue: { milestones: ['m1', 'm2'] } });
    expect(value).toEqual(['m1', 'm2']);
  });

  it('THROWS when the artifact field is absent (a promote of nothing is a wiring error, not silent)', async () => {
    tmp = await mkTmp();
    await writeJson(path.join(tmp, 'a.json'), { present: 1 });
    const spec: PromoteSpec = { from: 'a.json:absent', to: 'x', merge: 'set' };
    await expect(extractPromoteValue(spec, { run: tmp })).rejects.toThrow(/absent/);
  });
});

// ---------- applyPromotes (one node's promotes via the reducer) ----------
describe('applyPromotes — merge a node update into state via the reducer', () => {
  it("'set' overwrites the channel (default last-write)", () => {
    const out = applyPromotes({ archetype: 'old' }, [{ to: 'archetype', value: 'new', merge: 'set' }]);
    expect(out.state.archetype).toBe('new');
  });

  it("'append' concatenates — the prior element is KEPT, not overwritten", () => {
    const out = applyPromotes({ log: ['a'] }, [{ to: 'log', value: ['b'], merge: 'append' }]);
    expect(out.state.log).toEqual(['a', 'b']);
  });

  it("'deepMerge' recurses without dropping prior siblings", () => {
    const out = applyPromotes({ cfg: { a: 1 } }, [{ to: 'cfg', value: { b: 2 }, merge: 'deepMerge' }]);
    expect(out.state.cfg).toEqual({ a: 1, b: 2 });
  });

  it('records each applied promote (to/merge/value) for the io.json ledger', () => {
    const out = applyPromotes({}, [{ to: 'archetype', value: 'platformer', merge: 'set' }]);
    expect(out.promotes).toEqual([{ to: 'archetype', merge: 'set', value: 'platformer' }]);
  });
});

// ---------- barrierMerge (parallel stage barrier) ----------
describe('barrierMerge — serial+deterministic merge of parallel promotes at the stage barrier', () => {
  it('applies multiple nodes\' promotes serially into one state (distinct channels)', () => {
    const prior: RunState = { keep: true };
    const out = barrierMerge(prior, [
      { nodeId: 'w0', promotes: [{ to: 'archetype', value: 'platformer', merge: 'set' }] },
      { nodeId: 'w1', promotes: [{ to: 'milestones', value: ['m1'], merge: 'set' }] },
    ]);
    expect(out).toEqual({ keep: true, archetype: 'platformer', milestones: ['m1'] });
  });

  it('append from TWO parallel nodes into one channel concatenates deterministically (node order)', () => {
    const out = barrierMerge(
      { log: [] },
      [
        { nodeId: 'b', promotes: [{ to: 'log', value: ['from-b'], merge: 'append' }] },
        { nodeId: 'a', promotes: [{ to: 'log', value: ['from-a'], merge: 'append' }] },
      ],
    );
    // Applied in the GIVEN (deterministic) node order — b before a — never racily.
    expect(out.log).toEqual(['from-b', 'from-a']);
  });

  it('FLAGS a `set` channel written by TWO concurrent nodes as a conflict (ConflictError)', () => {
    expect(() =>
      barrierMerge({}, [
        { nodeId: 'a', promotes: [{ to: 'archetype', value: 'x', merge: 'set' }] },
        { nodeId: 'b', promotes: [{ to: 'archetype', value: 'y', merge: 'set' }] },
      ]),
    ).toThrow(ConflictError);
    expect(() =>
      barrierMerge({}, [
        { nodeId: 'a', promotes: [{ to: 'archetype', value: 'x', merge: 'set' }] },
        { nodeId: 'b', promotes: [{ to: 'archetype', value: 'y', merge: 'set' }] },
      ]),
    ).toThrow(/archetype/);
  });

  it('ALLOWS the same channel from two nodes when BOTH use append (a declared concurrent reducer)', () => {
    const out = barrierMerge({}, [
      { nodeId: 'a', promotes: [{ to: 'log', value: ['a'], merge: 'append' }] },
      { nodeId: 'b', promotes: [{ to: 'log', value: ['b'], merge: 'append' }] },
    ]);
    expect(out.log).toEqual(['a', 'b']);
  });

  it('ALLOWS the same channel from two nodes when BOTH use deepMerge', () => {
    const out = barrierMerge({}, [
      { nodeId: 'a', promotes: [{ to: 'cfg', value: { a: 1 }, merge: 'deepMerge' }] },
      { nodeId: 'b', promotes: [{ to: 'cfg', value: { b: 2 }, merge: 'deepMerge' }] },
    ]);
    expect(out.cfg).toEqual({ a: 1, b: 2 });
  });

  it('a SINGLE node may `set` a channel (one writer is never a conflict)', () => {
    const out = barrierMerge({ archetype: 'old' }, [
      { nodeId: 'solo', promotes: [{ to: 'archetype', value: 'new', merge: 'set' }] },
    ]);
    expect(out.archetype).toBe('new');
  });
});

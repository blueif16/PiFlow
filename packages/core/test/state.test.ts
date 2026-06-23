import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyReducer, mergeUpdate, loadState, persistState } from '../src/index.js';
import type { RunState } from '../src/index.js';

const tmp = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-state-'));

describe('applyReducer', () => {
  it("'set' overwrites the previous value (the default last-write reducer)", () => {
    expect(applyReducer('old', 'new', 'set')).toBe('new');
    expect(applyReducer([1, 2], [3], 'set')).toEqual([3]); // not concatenated
  });

  it("'append' concatenates both values as arrays — a 2-element append yields BOTH", () => {
    // The load-bearing reducer assertion: append must KEEP the prior element, not overwrite it.
    expect(applyReducer(['a'], ['b'], 'append')).toEqual(['a', 'b']);
  });

  it("'append' coerces non-array operands to single-element arrays before concat", () => {
    expect(applyReducer('a', 'b', 'append')).toEqual(['a', 'b']);
    expect(applyReducer(undefined, 'b', 'append')).toEqual(['b']);
  });

  it("'deepMerge' merges nested keys WITHOUT dropping the prior siblings", () => {
    const prev = { a: 1, nested: { x: 1, keep: true } };
    const next = { b: 2, nested: { y: 2 } };
    expect(applyReducer(prev, next, 'deepMerge')).toEqual({
      a: 1,
      b: 2,
      nested: { x: 1, keep: true, y: 2 },
    });
  });

  it("'deepMerge' REPLACES arrays (documented policy: arrays are leaves, not merged)", () => {
    const prev = { list: [1, 2], k: 'a' };
    const next = { list: [3] };
    expect(applyReducer(prev, next, 'deepMerge')).toEqual({ list: [3], k: 'a' });
  });
});

describe('mergeUpdate', () => {
  it("applies the channel's reducer to a single channel, returning a NEW state (immutable)", () => {
    const state: RunState = { archetype: 'old', items: ['a'] };
    const out = mergeUpdate(state, 'items', ['b'], 'append');
    expect(out.items).toEqual(['a', 'b']);
    expect(state.items).toEqual(['a']); // input not mutated
    expect(out.archetype).toBe('old'); // untouched channels preserved
  });

  it("defaults to 'set' when no reducer is given", () => {
    const out = mergeUpdate({ k: 'old' }, 'k', 'new');
    expect(out.k).toBe('new');
  });
});

describe('persistState / loadState', () => {
  it('round-trips the channels through state.json', async () => {
    const base = await tmp();
    try {
      const state: RunState = { archetype: 'platformer', milestones: ['m1', 'm2'], cfg: { speed: 5 } };
      await persistState(base, state);
      const back = await loadState(base);
      expect(back).toEqual(state);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('loadState returns {} when state.json is absent (a fresh run)', async () => {
    const base = await tmp();
    try {
      expect(await loadState(base)).toEqual({});
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});

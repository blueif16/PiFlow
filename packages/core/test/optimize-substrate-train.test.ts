// optimize/substrate/train.ts — the adopt TRAIN's PURE policy (docs/design/optimize-blame.md §6, WS-B5).
// These tests are fs/git-free by construction (the module has no fs/git): the staleness verdict table (every
// row, incl. the two conservative-degrade rows), the deterministic landing order, and the cycle-safe blame
// node order. Each assertion FAILS when the rule is wrong (proven by the test-the-test drill in the lane log).
//
// Run: npx vitest run packages/core/test/optimize-substrate-train.test.ts --project default

import { describe, it, expect } from 'vitest';
import {
  assessStaleness,
  pathInClosure,
  orderRecords,
  deriveNodeOrder,
  type StalenessVerdict,
} from '../src/optimize/substrate/train.js';
import type { BlameSummary } from '../src/optimize/blame/summary.js';

// ── assessStaleness — the §6 staleness table (every verdict row) ────────────────────────────────────────────
describe('assessStaleness — the pure §6 staleness verdict (incl. the conservative-degrade rows)', () => {
  const rows: { name: string; input: Parameters<typeof assessStaleness>[0]; want: StalenessVerdict }[] = [
    {
      name: 'baseSha === HEAD ⇒ fresh (even if a path would overlap — the base never moved)',
      input: { baseSha: 'abc', headSha: 'abc', interveningPaths: ['templates/x.json'], closure: ['templates'] },
      want: 'fresh',
    },
    {
      name: 'base moved, all intervening paths OUTSIDE the closure ⇒ disjoint',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: ['README.md', 'docs/x.md'], closure: ['templates'] },
      want: 'disjoint',
    },
    {
      name: 'base moved, an intervening path UNDER a closure dir ⇒ overlap',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: ['templates/level.json'], closure: ['templates'] },
      want: 'overlap',
    },
    {
      name: 'base moved, an intervening path EXACTLY a closure entry ⇒ overlap',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: ['templates'], closure: ['templates'] },
      want: 'overlap',
    },
    {
      name: 'CONSERVATIVE: baseSha missing (pre-WS0 record) ⇒ overlap, never disjoint',
      input: { baseSha: undefined, headSha: 'b', interveningPaths: ['README.md'], closure: [] },
      want: 'overlap',
    },
    {
      name: 'CONSERVATIVE: intervening diff unreadable (undefined) ⇒ overlap, never disjoint',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: undefined, closure: ['templates'] },
      want: 'overlap',
    },
    {
      name: 'base moved, EMPTY closure + readable diff ⇒ disjoint (nothing this node owns moved)',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: ['templates/x.json'], closure: [] },
      want: 'disjoint',
    },
    {
      name: 'base moved, EMPTY readable diff (nothing moved between two shas) ⇒ disjoint',
      input: { baseSha: 'a', headSha: 'b', interveningPaths: [], closure: ['templates'] },
      want: 'disjoint',
    },
  ];
  for (const r of rows) {
    it(r.name, () => {
      expect(assessStaleness(r.input)).toBe(r.want);
    });
  }
});

// ── pathInClosure — the shared prefix rule (exact | under-a-dir; never a sibling-prefix) ─────────────────────
describe('pathInClosure — exact match or under a closure dir, never a sibling-prefix false hit', () => {
  it('exact match hits; a path under a closure dir hits; an unrelated path misses', () => {
    expect(pathInClosure('templates', ['templates'])).toBe(true);
    expect(pathInClosure('templates/a/b.json', ['templates'])).toBe(true);
    expect(pathInClosure('src/index.ts', ['templates', 'eval'])).toBe(false);
  });
  it('a sibling that only shares a prefix is NOT under the closure dir', () => {
    expect(pathInClosure('templatesX/y.json', ['templates'])).toBe(false);
  });
});

// ── orderRecords — the deterministic landing order (nodeOrder first, then node asc, then issue asc) ──────────
describe('orderRecords — deterministic landing order (completion order never dictates landing order)', () => {
  const recs = [
    { node: 'render', issue: 'zebra' },
    { node: 'author', issue: 'beta' },
    { node: 'author', issue: 'alpha' },
    { node: 'render', issue: 'apple' },
  ];

  it('nodes in nodeOrder come first IN that order; issues sort asc within a node', () => {
    const out = orderRecords(recs, ['render', 'author']);
    expect(out.map((r) => `${r.node}/${r.issue}`)).toEqual([
      'render/apple', 'render/zebra', 'author/alpha', 'author/beta',
    ]);
  });

  it('a node ABSENT from nodeOrder sorts AFTER every ranked node, unknown nodes node-asc', () => {
    const withUnknown = [...recs, { node: 'plan', issue: 'gamma' }];
    const out = orderRecords(withUnknown, ['render']);
    // render ranked first; then unknown nodes (author, plan) node-asc, issues asc within.
    expect(out.map((r) => `${r.node}/${r.issue}`)).toEqual([
      'render/apple', 'render/zebra', 'author/alpha', 'author/beta', 'plan/gamma',
    ]);
  });

  it('no nodeOrder ⇒ pure node asc then issue asc; the input array is NOT mutated', () => {
    const before = recs.map((r) => `${r.node}/${r.issue}`);
    const out = orderRecords(recs);
    expect(out.map((r) => `${r.node}/${r.issue}`)).toEqual([
      'author/alpha', 'author/beta', 'render/apple', 'render/zebra',
    ]);
    expect(recs.map((r) => `${r.node}/${r.issue}`)).toEqual(before); // pure — no mutation
  });
});

// ── orderRecords — WITHIN a node: severity-desc, then firstSeen-asc (§5 MODE P / §6) ─────────────────────────
describe('orderRecords — within a node the HIGHER severity lands first (priority, not name)', () => {
  it('a critical issue lands before a low one on the SAME node, regardless of issue NAME', () => {
    const recs = [
      { node: 'N', issue: 'aaa', severity: 'low' as const },
      { node: 'N', issue: 'zzz', severity: 'critical' as const },
    ];
    // name-asc would land 'aaa' first (the priority INVERSION); severity-desc lands 'zzz' (critical) first.
    expect(orderRecords(recs).map((r) => r.issue)).toEqual(['zzz', 'aaa']);
  });

  it('SAME severity ⇒ firstSeen-asc (oldest first), then issue-name asc as the deterministic tail', () => {
    const recs = [
      { node: 'N', issue: 'b', severity: 'high' as const, firstSeen: '260709-02' },
      { node: 'N', issue: 'a', severity: 'high' as const, firstSeen: '260709-01' },
    ];
    expect(orderRecords(recs).map((r) => r.issue)).toEqual(['a', 'b']); // firstSeen 01 before 02
  });

  it('a record with NO severity ranks LAST within a node (never jumps a declared one)', () => {
    const recs = [
      { node: 'N', issue: 'aaa' },                            // undeclared
      { node: 'N', issue: 'bbb', severity: 'low' as const },  // declared low
    ];
    expect(orderRecords(recs).map((r) => r.issue)).toEqual(['bbb', 'aaa']);
  });

  it('severity ranking never leaks ACROSS nodes — nodeOrder still dominates', () => {
    const recs = [
      { node: 'author', issue: 'x', severity: 'critical' as const },
      { node: 'render', issue: 'y', severity: 'low' as const },
    ];
    // render is ranked first by nodeOrder even though its issue is lower-severity than author's.
    expect(orderRecords(recs, ['render', 'author']).map((r) => r.node)).toEqual(['render', 'author']);
  });
});

// ── deriveNodeOrder — upstream-first Kahn over the blame edges, CYCLE-SAFE ───────────────────────────────────
describe('deriveNodeOrder — the upstream-first topological order over the blame graph (cycle-safe)', () => {
  const summary = (blamed: string[], edges: [string, string][]): BlameSummary => ({
    blamed: blamed.map((node) => ({ node, severity: 'high', observedAt: [] })),
    edges,
    unattributed: [],
  });

  it('a chain owner→observed lands the owner (upstream) first', () => {
    expect(deriveNodeOrder(summary(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]))).toEqual(['a', 'b', 'c']);
  });

  it('tied in-degree-0 nodes break node-asc; a fan-out orders the owner then targets asc', () => {
    expect(deriveNodeOrder(summary(['a', 'b', 'c'], [['a', 'c'], ['a', 'b']]))).toEqual(['a', 'b', 'c']);
  });

  it('no edges ⇒ node-asc over the blamed nodes', () => {
    expect(deriveNodeOrder(summary(['render', 'author', 'plan'], []))).toEqual(['author', 'plan', 'render']);
  });

  it('a CYCLE degrades to node-asc for the cyclic nodes and never hangs', () => {
    expect(deriveNodeOrder(summary(['b', 'a'], [['a', 'b'], ['b', 'a']]))).toEqual(['a', 'b']);
  });

  it('a clean chain PLUS a disjoint cycle: chain topo first, cycle appended node-asc', () => {
    const out = deriveNodeOrder(summary(['x', 'y', 'p', 'q'], [['x', 'y'], ['p', 'q'], ['q', 'p']]));
    expect(out).toEqual(['x', 'y', 'p', 'q']);
  });

  it('an edge endpoint not listed in blamed is still ordered', () => {
    expect(deriveNodeOrder(summary(['a'], [['a', 'z']]))).toEqual(['a', 'z']);
  });
});

// `searchSkillIndex` — the CLIENT-SIDE ranker over the bundled skills-index artifact (the same pure module
// runs in the GUI bundle and in the CLI's 'index' source, so ranking can never disagree between surfaces).
// PURE LOGIC gate (test-discipline §0): ranking BEHAVIORS are pinned — not exact scores (weights may tune),
// but ORDERINGS that must hold whatever the weights:
//   • a name hit outranks a description-only hit for the same term
//   • a doc matching ALL query terms outranks a doc matching a strict subset
//   • among text-equal docs, higher popularity wins; quality breaks a popularity tie
//   • docs matching NO term never surface; empty/whitespace queries return nothing
//   • `limit` caps the ranked list from the top, not arbitrarily

import { describe, it, expect } from 'vitest';
import { searchSkillIndex, type SkillIndexDoc } from '../src/workflow/ops/skill-index-search.js';

function doc(over: Partial<SkillIndexDoc>): SkillIndexDoc {
  return {
    slug: over.slug ?? over.name ?? 'x',
    name: 'placeholder',
    description: '',
    source: 'https://github.com/o/r',
    index: 'skillregistry',
    ...over,
  };
}

describe('searchSkillIndex — ranking behaviors', () => {
  it('a NAME hit outranks a description-only hit', () => {
    const docs = [
      doc({ slug: 'a', name: 'unrelated-tool', description: 'helps you review kubernetes manifests' }),
      doc({ slug: 'b', name: 'kubernetes-helper', description: 'a general helper' }),
    ];
    const ranked = searchSkillIndex(docs, 'kubernetes');
    expect(ranked.map((d) => d.slug)).toEqual(['b', 'a']);
  });

  it('matching ALL query terms outranks matching a subset', () => {
    const docs = [
      doc({ slug: 'partial', name: 'code-formatter', description: 'formats code beautifully' }),
      doc({ slug: 'full', name: 'code-review', description: 'reviews code for bugs' }),
    ];
    const ranked = searchSkillIndex(docs, 'code review');
    expect(ranked[0].slug).toBe('full');
  });

  it('text-equal docs: higher popularity wins; quality breaks a popularity tie', () => {
    const docs = [
      doc({ slug: 'small', name: 'pdf', description: 'pdf tools', pop: 10 }),
      doc({ slug: 'big', name: 'pdf', description: 'pdf tools', pop: 50_000 }),
      doc({ slug: 'quality', name: 'pdf', description: 'pdf tools', pop: 50_000, quality: 95 }),
    ];
    const ranked = searchSkillIndex(docs, 'pdf');
    expect(ranked.map((d) => d.slug)).toEqual(['quality', 'big', 'small']);
  });

  it('docs matching no query term never surface', () => {
    const docs = [
      doc({ slug: 'hit', name: 'stripe-integration', description: 'payments' }),
      doc({ slug: 'miss', name: 'kubernetes-ops', description: 'cluster management' }),
    ];
    const ranked = searchSkillIndex(docs, 'stripe');
    expect(ranked.map((d) => d.slug)).toEqual(['hit']);
  });

  it('empty and whitespace queries return nothing (the caller shows the idle hint instead)', () => {
    const docs = [doc({ slug: 'a', name: 'anything' })];
    expect(searchSkillIndex(docs, '')).toEqual([]);
    expect(searchSkillIndex(docs, '   ')).toEqual([]);
  });

  it('limit caps from the TOP of the ranking', () => {
    const docs = [
      doc({ slug: 'low', name: 'pdf', pop: 1 }),
      doc({ slug: 'high', name: 'pdf', pop: 100_000 }),
      doc({ slug: 'mid', name: 'pdf', pop: 500 }),
    ];
    const ranked = searchSkillIndex(docs, 'pdf', 2);
    expect(ranked.map((d) => d.slug)).toEqual(['high', 'mid']);
  });

  it('popularity can NEVER outrank text relevance (a giant irrelevant doc stays below a small exact hit)', () => {
    const docs = [
      doc({ slug: 'giant-miss', name: 'react-best-practices', description: 'react patterns', pop: 1_000_000 }),
      doc({ slug: 'exact', name: 'xlsx', description: 'spreadsheets', pop: 0 }),
    ];
    const ranked = searchSkillIndex(docs, 'xlsx');
    expect(ranked.map((d) => d.slug)).toEqual(['exact']);
  });
});

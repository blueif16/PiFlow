import { describe, it, expect } from 'vitest';
// The RANKER is the heart of FIND and now the ONE scoring source — a pure, vendored `.mjs` so `.agents/okf/`
// alone gives ranked retrieval on `node` (no piflowctl) and so the scoring is unit-testable in-process. These
// pin OWNERSHIP-over-mention + the tokenized phrase fallback: the exact behavior the CLI reader and the
// optimizer's fixer wire now source from the engine's `--find`. If this drifts, FIND silently regresses.
import { parseCardForRank, rankCards } from '../../../.agents/okf/topics/_rank.mjs';

// A minimal card fixture. `prose` goes in the CURATED body (a WEAK match), never frontmatter.
const card = (o: {
  key: string;
  title?: string;
  resource?: string;
  aliases?: string[];
  seeds?: string[];
  symbols?: string[];
  tags?: string[];
  prose?: string;
}): string =>
  [
    '---',
    'type: subsystem',
    `key: ${o.key}`,
    `title: ${o.title ?? o.key + ' subsystem'}`,
    ...(o.resource ? [`resource: ${o.resource}`] : []),
    ...(o.aliases ? [`aliases: [${o.aliases.join(', ')}]`] : []),
    ...(o.seeds ? [`seeds: [${o.seeds.join(', ')}]`] : []),
    ...(o.symbols ? [`symbols: [${o.symbols.join(', ')}]`] : []),
    ...(o.tags ? [`tags: [${o.tags.join(', ')}]`] : []),
    '---',
    '',
    '# Why / how it works',
    o.prose ?? 'A subsystem.',
    '',
    '<!-- okf:auto-start -->',
    'auto region — regenerated content lives here',
    '<!-- okf:auto-end -->',
    '',
  ].join('\n');

describe('parseCardForRank — frontmatter + curated split (the ranker card shape)', () => {
  it('parses scalars, inline arrays, and excludes the auto region from the curated body', () => {
    const c = parseCardForRank(
      'sandbox',
      card({ key: 'sandbox', title: 'The jail', symbols: ['computeScopeRoots'], seeds: ['a/b.ts'], prose: 'declares the jail.' }),
    );
    expect(c.key).toBe('sandbox');
    expect(c.title).toBe('The jail');
    expect(c.symbols).toEqual(['computeScopeRoots']);
    expect(c.seeds).toEqual(['a/b.ts']);
    expect(c.curatedLower).toContain('declares the jail');
    expect(c.curatedLower).not.toContain('regenerated content'); // the auto region never leaks into the match
  });
});

describe('rankCards — ownership beats mention (deterministic)', () => {
  const cards = [
    parseCardForRank('runner', card({ key: 'runner', symbols: ['runNode'], prose: 'the runner also calls computeScopeRoots at exec.' })),
    parseCardForRank('sandbox', card({ key: 'sandbox', resource: 'packages/core/src/sandbox/scope.ts', symbols: ['computeScopeRoots'], seeds: ['packages/core/src/sandbox/scope.ts'] })),
    parseCardForRank('optimize', card({ key: 'optimize', symbols: ['scoreRun'] })),
  ];

  it('an exact key match ranks first for that query', () => {
    expect(rankCards(cards, 'runner')[0].card.key).toBe('runner');
  });

  it('a card that OWNS a symbol outranks one that only MENTIONS it in prose', () => {
    const ranked = rankCards(cards, 'computeScopeRoots');
    expect(ranked[0].card.key).toBe('sandbox');
    const runnerRank = ranked.findIndex((r) => r.card.key === 'runner');
    const sandboxRank = ranked.findIndex((r) => r.card.key === 'sandbox');
    expect(sandboxRank).toBeLessThan(runnerRank); // ownership strictly above mention
  });

  it('a FILE query resolves to the card that owns the file', () => {
    expect(rankCards(cards, 'packages/core/src/sandbox/scope.ts')[0].card.key).toBe('sandbox');
  });

  it('a query no card owns or mentions returns nothing (uncovered)', () => {
    expect(rankCards(cards, 'totally-unrelated-xyz')).toEqual([]);
  });
});

describe('rankCards — tokenized PHRASE fallback (a natural-language question still finds its owner)', () => {
  const cards = [
    parseCardForRank('sandbox', card({ key: 'sandbox', aliases: ['jail', 'seatbelt'], seeds: ['packages/core/src/sandbox/scope.ts'] })),
    parseCardForRank('runner', card({ key: 'runner', symbols: ['runWorkflow'], prose: 'one pi per node, artifacts on disk.' })),
  ];

  it('a multi-word question whose TOKENS hit ownership fields resolves to the owning card', () => {
    expect(rankCards(cards, 'jail reads and writes inside the box')[0].card.key).toBe('sandbox');
  });

  it('a phrase whose tokens hit nothing still returns [] (uncovered, never a noise crown)', () => {
    expect(rankCards(cards, 'stripe payment webhook retries')).toEqual([]);
  });

  it('a phrase grazing only PROSE stays below the ownership floor (weak mentions cannot crown an owner)', () => {
    // "artifacts disk" appear only in runner's prose (8 pts each, no ownership hit) → structurally uncovered.
    expect(rankCards(cards, 'artifacts written straight onto disk')).toEqual([]);
  });
});

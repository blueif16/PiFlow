import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCard, rankCards, resolveTopicsDir, resolveSlice, runUnderstandCli } from '../src/understand.js';

// `piflowctl understand` is the user-facing name for the OKF code-understanding slices: FIND the slice that
// owns a subsystem, and run the drift gate (--check) / regenerate (--rebuild). The RANKER is the heart — a
// deterministic projection of "which card owns this query", where OWNERSHIP (frontmatter: key/resource/
// seeds/symbols/aliases) must beat a bare PROSE mention. These tests pin that ranking and the substrate
// resolution; --check/--rebuild are thin wrappers over the engine (`_generate.mjs`), tested via an injected
// gate so they don't shell out.

// A minimal card fixture. `proseOnly` goes in the CURATED body (a WEAK match), never frontmatter.
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

describe('parseCard — frontmatter + curated split', () => {
  it('parses scalars, inline arrays, and excludes the auto region from the curated body', () => {
    const c = parseCard(
      'sandbox',
      card({ key: 'sandbox', title: 'The jail', symbols: ['computeScopeRoots'], seeds: ['a/b.ts'], prose: 'declares the jail.' }),
    );
    expect(c.key).toBe('sandbox');
    expect(c.title).toBe('The jail');
    expect(c.symbols).toEqual(['computeScopeRoots']);
    expect(c.seeds).toEqual(['a/b.ts']);
    // The curated half carries the prose but NOT the auto region (so a prose match is genuine, not the
    // regenerated block leaking in).
    expect(c.curatedLower).toContain('declares the jail');
    expect(c.curatedLower).not.toContain('regenerated content');
  });
});

describe('rankCards — ownership beats mention (deterministic)', () => {
  const cards = [
    parseCard('runner', card({ key: 'runner', symbols: ['runNode'], prose: 'the runner also calls computeScopeRoots at exec.' })),
    parseCard('sandbox', card({ key: 'sandbox', resource: 'packages/core/src/sandbox/scope.ts', symbols: ['computeScopeRoots'], seeds: ['packages/core/src/sandbox/scope.ts'] })),
    parseCard('optimize', card({ key: 'optimize', symbols: ['scoreRun'] })),
  ];

  it('an exact key match ranks first for that query', () => {
    expect(rankCards(cards, 'runner')[0].card.key).toBe('runner');
  });

  it('a card that OWNS a symbol outranks one that only MENTIONS it in prose', () => {
    // sandbox declares `computeScopeRoots` in symbols:; runner merely name-drops it in its prose.
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

describe('resolveTopicsDir — walk up to the .agents/okf/topics engine', () => {
  let ROOT: string;
  beforeEach(async () => {
    ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-understand-'));
  });
  afterEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('finds the topics dir from a nested subdir; returns null when there is no substrate', async () => {
    const topics = path.join(ROOT, '.agents', 'okf', 'topics');
    await fs.mkdir(topics, { recursive: true });
    await fs.writeFile(path.join(topics, '_generate.mjs'), '// engine\n');
    const nested = path.join(ROOT, 'packages', 'core', 'src');
    await fs.mkdir(nested, { recursive: true });

    expect(resolveTopicsDir(nested)).toBe(topics);
    // A sibling temp dir with no substrate resolves to null.
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-nosubstrate-'));
    expect(resolveTopicsDir(bare)).toBeNull();
    await fs.rm(bare, { recursive: true, force: true });
  });
});

describe('resolveSlice — dereference a slice KEY to its curated body (the Leg-A→Leg-B resolve-at-read)', () => {
  let topics: string;
  beforeEach(async () => {
    topics = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-resolveslice-'));
    await fs.writeFile(path.join(topics, 'runner.md'), card({ key: 'runner', title: 'Runner spine', prose: 'drives the DAG one pi per node.' }));
  });
  afterEach(async () => {
    await fs.rm(topics, { recursive: true, force: true });
  });

  it('returns the curated body ONLY — frontmatter and the auto region are stripped (never a copy of the whole card)', () => {
    const body = resolveSlice(topics, 'runner');
    expect(body).toBeTruthy();
    expect(body).toContain('drives the DAG one pi per node'); // the curated "how it works"
    expect(body).not.toContain('regenerated content'); // the machine auto-region is excluded
    expect(body).not.toContain('type: subsystem'); // frontmatter is excluded
  });

  it('returns null when the linked slice is absent (a dangling pointer — the fixer still gets root/prevention)', () => {
    expect(resolveSlice(topics, 'nonexistent')).toBeNull();
  });
});

describe('runUnderstandCli — the three modes', () => {
  let ROOT: string;
  let topics: string;
  let out = '';
  let err = '';
  let outSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-understand-cli-'));
    topics = path.join(ROOT, '.agents', 'okf', 'topics');
    await fs.mkdir(topics, { recursive: true });
    await fs.writeFile(path.join(topics, '_generate.mjs'), '// engine\n');
    await fs.writeFile(path.join(topics, 'runner.md'), card({ key: 'runner', title: 'Runner spine', prose: 'drives the DAG one pi per node.' }));
    await fs.writeFile(path.join(topics, 'sandbox.md'), card({ key: 'sandbox', title: 'The jail', symbols: ['computeScopeRoots'] }));
    // A `_`-prefixed file (the engine + its test) must be IGNORED as a card.
    await fs.writeFile(path.join(topics, '_generate.test.mjs'), '// not a card\n');
    out = '';
    err = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => ((err += String(c)), true));
    process.exitCode = 0;
  });
  afterEach(async () => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.exitCode = 0;
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('bare `understand` lists the covered subsystems (the index), never the engine files', async () => {
    await runUnderstandCli([], { cwd: topics });
    expect(out).toContain('runner');
    expect(out).toContain('sandbox');
    expect(out).not.toContain('_generate'); // `_`-prefixed files are engine, not slices
  });

  it('`understand <subsystem>` prints the owning card body', async () => {
    await runUnderstandCli(['runner'], { cwd: topics });
    expect(out).toContain('Runner spine');
    expect(out).toContain('drives the DAG one pi per node');
  });

  it('`understand <uncovered>` reports the gap and does NOT invent a slice', async () => {
    await runUnderstandCli(['nonexistent-subsystem'], { cwd: topics });
    expect(out + err).toMatch(/uncovered|no slice|no match/i);
    expect(out).not.toContain('Runner spine');
  });

  it('`understand --check` routes to the gate and propagates its exit code', async () => {
    const calls: Array<{ mode: string; keys: string[] }> = [];
    const runGate = (mode: 'check' | 'write', _dir: string, keys: string[]): number => {
      calls.push({ mode, keys });
      return 1; // simulate a HEALTH failure
    };
    await runUnderstandCli(['--check'], { cwd: topics, runGate });
    expect(calls).toEqual([{ mode: 'check', keys: [] }]);
    expect(Number(process.exitCode ?? 0)).toBe(1);
  });

  it('`understand --rebuild <key>` routes to the writer scoped to that key', async () => {
    const calls: Array<{ mode: string; keys: string[] }> = [];
    const runGate = (mode: 'check' | 'write', _dir: string, keys: string[]): number => {
      calls.push({ mode, keys });
      return 0;
    };
    await runUnderstandCli(['--rebuild', 'sandbox'], { cwd: topics, runGate });
    expect(calls).toEqual([{ mode: 'write', keys: ['sandbox'] }]);
  });

  it('errors clearly (exit != 0) when there is no .agents/okf substrate', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-understand-bare-'));
    await runUnderstandCli(['--check'], { cwd: bare });
    expect(Number(process.exitCode ?? 0)).not.toBe(0);
    expect(err).toMatch(/\.agents\/okf|no code map|not set up/i);
    process.exitCode = 0;
    await fs.rm(bare, { recursive: true, force: true });
  });
});

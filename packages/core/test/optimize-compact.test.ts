// Contract for optimize/compact.ts — the cap/retire COMPACTION pass (piflow-memory-v1.5 §5.3; memory-slices
// MODE B). A SEPARATE, out-of-band pass that keeps memory.md bounded by RETIRING discrete lowest-value lesson
// blocks — never re-summarizing. The oracle is the ROUND-TRIP: after compaction, `deriveRecurrence` reads back
// exactly the kept blocks (and only those), and every kept block is byte-identical to its original.
//
// Run: npx vitest run packages/core/test/optimize-compact.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compactMemory, DEFAULT_MAX_LESSONS } from '../src/optimize/compact.js';
import { deriveRecurrence } from '../src/optimize/recurrence.js';

const tmpDirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'piflow-compact-'));
  tmpDirs.push(d);
  return d;
};
afterEach(async () => {
  const { rmSync } = await import('node:fs');
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A lesson block in the exact grammar the reader/writer share. `sig` is `<node>::<key>`.
const block = (node: string, key: string, recurrence: number, okfSlice?: string): string =>
  [
    `### ${node} ${key}`,
    `sig: ${node}::${key}`,
    `recurrence: ${recurrence}`,
    ...(okfSlice ? [`[[${okfSlice}]]`] : []),
    `**Root:** ${key} root`,
    `**Prevention:** ${key} guard`,
  ].join('\n');

// Assemble a realistic memory.md: the section spine + the given blocks under "## Known failure modes".
const memoryFile = (dir: string, node: string, blocks: string[]): string => {
  mkdirSync(join(dir, 'nodes', node), { recursive: true });
  const path = join(dir, 'nodes', node, 'memory.md');
  const body = [
    `# node: ${node} — memory`,
    '',
    '## Current behavior',
    'does the thing',
    '',
    '## Known failure modes',
    ...blocks.flatMap((b) => ['', b]),
    '',
    '## Active invariants',
    'writes only within owns',
    '',
    '## History',
    `git log --grep '^skillsys(${node})'`,
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return path;
};

describe('compactMemory — cap-eviction retires the lowest-value (lowest-recurrence) block', () => {
  it('over the cap: retires the recurrence-1 block, keeps the higher-recurrence ones (round-trips through deriveRecurrence)', () => {
    const dir = scratch();
    // three blocks: recurrence 3, 1, 2 — laid out of order so the test can only pass by RANKING on recurrence.
    const file = memoryFile(dir, 'flaky', [
      block('flaky', 'alpha', 3),
      block('flaky', 'beta', 1),
      block('flaky', 'gamma', 2),
    ]);

    const res = compactMemory(file, { maxLessons: 2 });

    // the single lowest-value block (beta, recurrence 1) is retired for cap-eviction; alpha+gamma remain.
    expect(res.retired).toEqual([{ sig: 'flaky::beta', recurrence: 1, reason: 'cap-eviction' }]);
    expect(res.keptSigs.sort()).toEqual(['flaky::alpha', 'flaky::gamma']);

    // the ORACLE: the shipped reader now sees exactly the two kept blocks, at their counts — beta is gone.
    const idx = deriveRecurrence({ templateDir: dir, nodes: ['flaky'] });
    expect(idx.get('flaky::alpha')?.count).toBe(3);
    expect(idx.get('flaky::gamma')?.count).toBe(2);
    expect(idx.has('flaky::beta')).toBe(false);

    // non-lesson content survives (compaction deletes blocks, it does not rewrite the file).
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('## Current behavior');
    expect(after).toContain('## Active invariants');
  });
});

describe('compactMemory — unconditional retires (graduated / code-shifted) fire regardless of the cap', () => {
  it('graduated: a lesson whose fix graduated to git/code is retired even when UNDER the cap', () => {
    const dir = scratch();
    const file = memoryFile(dir, 'flaky', [block('flaky', 'alpha', 5), block('flaky', 'beta', 2)]);

    // maxLessons 8 ⇒ no cap pressure; only the injected graduated set drives the retire.
    const res = compactMemory(file, { maxLessons: 8, graduated: new Set(['flaky::alpha']) });

    expect(res.retired).toEqual([{ sig: 'flaky::alpha', recurrence: 5, reason: 'graduated' }]);
    expect(res.keptSigs).toEqual(['flaky::beta']);
    const idx = deriveRecurrence({ templateDir: dir, nodes: ['flaky'] });
    expect(idx.has('flaky::alpha')).toBe(false);
    expect(idx.get('flaky::beta')?.count).toBe(2);
  });

  it('code-shifted: a lesson whose linked slice went stale is retired, and reports the code-shifted reason', () => {
    const dir = scratch();
    const file = memoryFile(dir, 'flaky', [block('flaky', 'alpha', 3, 'runner'), block('flaky', 'beta', 1)]);

    const res = compactMemory(file, { maxLessons: 8, codeShifted: new Set(['flaky::alpha']) });

    expect(res.retired).toEqual([{ sig: 'flaky::alpha', recurrence: 3, reason: 'code-shifted' }]);
    expect(res.keptSigs).toEqual(['flaky::beta']);
  });
});

describe('compactMemory — under the cap with no signals is a no-op (never re-summarizes)', () => {
  it('leaves the file byte-for-byte unchanged and retires nothing', () => {
    const dir = scratch();
    const file = memoryFile(dir, 'flaky', [block('flaky', 'alpha', 1), block('flaky', 'beta', 1)]);
    const before = readFileSync(file, 'utf8');

    const res = compactMemory(file, { maxLessons: DEFAULT_MAX_LESSONS });

    expect(res.retired).toEqual([]);
    expect(res.keptSigs).toEqual(['flaky::alpha', 'flaky::beta']);
    expect(readFileSync(file, 'utf8')).toBe(before); // untouched — no rewrite
  });

  it('kept blocks are byte-identical to their originals (discrete delete, not a re-summarization)', () => {
    const dir = scratch();
    const keptBlock = block('flaky', 'alpha', 4);
    const file = memoryFile(dir, 'flaky', [keptBlock, block('flaky', 'beta', 1), block('flaky', 'gamma', 1)]);

    compactMemory(file, { maxLessons: 1 }); // evicts beta+gamma (recurrence 1), keeps alpha (recurrence 4)

    const after = readFileSync(file, 'utf8');
    expect(after).toContain(keptBlock); // the surviving block's exact text is preserved verbatim
    expect(after).not.toContain('sig: flaky::beta');
    expect(after).not.toContain('sig: flaky::gamma');
  });
});

describe('compactMemory — a missing file is a no-op (never throws)', () => {
  it('returns an empty result for a path that does not exist', () => {
    const dir = scratch();
    const res = compactMemory(join(dir, 'nodes', 'ghost', 'memory.md'));
    expect(res).toEqual({ file: join(dir, 'nodes', 'ghost', 'memory.md'), retired: [], keptSigs: [] });
  });
});

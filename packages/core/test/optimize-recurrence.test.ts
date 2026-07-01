// Contract for optimize/recurrence.ts — the FIRST reader of Leg-A `memory.md` (piflow-memory-v1.5 §3, §7).
// `signatureOf` is the PURE, stable failure-signature key (node::sorted-anomalies|reason); `deriveRecurrence`
// is the ONLY I/O — it reads per-node + system `memory.md`, parses LESSON BLOCKS, and returns the recurrence
// index the triage projector consults to flip LAPSE→SKILL when a signature RECURS.
//
// Run: npx vitest run packages/core/test/optimize-recurrence.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signatureOf, deriveRecurrence } from '../src/optimize/recurrence.js';

const tmpDirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'piflow-recurrence-'));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('signatureOf — the stable failure-signature key', () => {
  it('is stable under anomaly reordering (sorted before joining)', () => {
    const a = signatureOf({ node: 'n', tier0: { anomalies: ['b', 'a'], disqualified: true } });
    const b = signatureOf({ node: 'n', tier0: { anomalies: ['a', 'b'], disqualified: true } });
    expect(a).toBe(b);
    expect(a).toBe('n::a+b');
  });

  it('falls back to reason (then "underperformed") when there are no anomalies', () => {
    expect(signatureOf({ node: 'n', tier0: { anomalies: [], disqualified: true, reason: 'failed' } }))
      .toBe('n::failed');
    expect(signatureOf({ node: 'n', tier0: { anomalies: [], disqualified: false } }))
      .toBe('n::underperformed');
  });
});

describe('deriveRecurrence — the Leg-A memory.md recurrence reader', () => {
  const writeNodeMemory = (templateDir: string, node: string, body: string) => {
    const dir = join(templateDir, 'nodes', node);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'memory.md'), body, 'utf8');
  };

  it('parses a lesson block in the locked format into the index keyed by sig', () => {
    const templateDir = scratch();
    writeNodeMemory(templateDir, 'flaky', [
      '# node: flaky — memory',
      '',
      '## Known failure modes',
      '',
      '### null deref in update()',
      'sig: flaky::failed',
      'recurrence: 3',
      '[[runner]]',
      '**Root:** update() assumed entries was defined',
      '**Prevention:** guard the null case',
      '',
      '## Active invariants',
    ].join('\n'));

    const idx = deriveRecurrence({ templateDir, nodes: ['flaky'] });
    const hit = idx.get('flaky::failed');
    expect(hit).toBeDefined();
    expect(hit!.count).toBe(3);
    expect(hit!.lesson?.root).toBe('update() assumed entries was defined');
    expect(hit!.lesson?.prevention).toBe('guard the null case');
    expect(hit!.lesson?.okfSlice).toBe('runner');
  });

  it('skips a block that has no sig: line (not guessable)', () => {
    const templateDir = scratch();
    writeNodeMemory(templateDir, 'flaky', [
      '### an unkeyed lesson',
      'recurrence: 9',
      '**Prevention:** something',
    ].join('\n'));

    const idx = deriveRecurrence({ templateDir, nodes: ['flaky'] });
    expect(idx.size).toBe(0);
  });

  it('defaults count to 0 when recurrence: is absent', () => {
    const templateDir = scratch();
    writeNodeMemory(templateDir, 'flaky', ['### x', 'sig: flaky::failed'].join('\n'));
    const idx = deriveRecurrence({ templateDir, nodes: ['flaky'] });
    expect(idx.get('flaky::failed')?.count).toBe(0);
  });

  it('missing files/dirs → empty index, never throws', () => {
    const idx = deriveRecurrence({ templateDir: join(tmpdir(), 'does-not-exist-piflow-xyz'), nodes: ['nope'] });
    expect(idx.size).toBe(0);
  });
});

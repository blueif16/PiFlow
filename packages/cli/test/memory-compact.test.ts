import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemoryCompactCli, codeShiftedInjector } from '../src/memory-compact.js';

// `piflowctl memory compact <templateDir>` wires the built-but-uncalled core `compactMemory` (which retires
// discrete lowest-value lesson blocks — graduated / code-shifted / over-cap) as an OUT-OF-BAND verb. This
// task's NET-NEW seam (already-tested `compactMemory` is NOT re-tested here) is: the two deterministic
// retire-trigger INJECTORS (codeShifted rides the OKF gate through the [[okf-slice]] link; graduated reads
// git), and the DRY-RUN-by-default gating (a bare `memory compact` mutates nothing; only --apply rewrites).
// Each test pins an observable with a mutation that makes it fail when the code is wrong.

// A real lesson block in the per-node grammar (recurrence.ts:12-20): `### heading` opens it; `sig:` is the
// machine key; `recurrence:` the cross-run count; `[[slice]]` the code-map pointer; Root/Prevention the prose.
const block = (node: string, key: string, recurrence: number, okfSlice?: string): string =>
  [
    `### ${node} ${key}`,
    `sig: ${node}::${key}`,
    `recurrence: ${recurrence}`,
    ...(okfSlice ? [`[[${okfSlice}]]`] : []),
    `**Root:** ${key} root`,
    `**Prevention:** ${key} guard`,
    '',
  ].join('\n');

// Assemble a realistic per-node memory.md under `<dir>/nodes/<node>/memory.md`.
async function writeMemory(dir: string, node: string, blocks: string[]): Promise<string> {
  await fs.mkdir(path.join(dir, 'nodes', node), { recursive: true });
  const p = path.join(dir, 'nodes', node, 'memory.md');
  const body = [
    `# node: ${node} — memory`,
    '',
    '## Known failure modes',
    ...blocks.flatMap((b) => ['', b]),
    '',
    '## Active invariants',
    'writes only within owns',
    '',
  ].join('\n');
  await fs.writeFile(p, body, 'utf8');
  return p;
}

// Seed a minimal OKF substrate up the tree so `resolveTopicsDir(templateDir)` resolves (the injector needs a
// present slice file per key to gate it — an absent slice is dangling, not code-shifted).
async function seedOkf(dir: string, keys: string[]): Promise<string> {
  const topics = path.join(dir, '.agents', 'okf', 'topics');
  await fs.mkdir(topics, { recursive: true });
  await fs.writeFile(path.join(topics, '_generate.mjs'), '// engine\n');
  for (const k of keys) {
    await fs.writeFile(
      path.join(topics, `${k}.md`),
      ['---', `key: ${k}`, `title: ${k} slice`, '---', '', `how ${k} works.`, ''].join('\n'),
    );
  }
  return topics;
}

describe('memory compact — codeShifted injector rides the OKF gate through the [[okf-slice]] link', () => {
  let DIR: string;
  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-compact-cs-'));
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test A — the injector returns EXACTLY the sigs whose LINKED slice is HEALTH-stale (per-key attribution),
  // not every sig on a node that has any stale slice. This is the pointer + resolve-at-read contract.
  it('returns only the sig whose linked slice went HEALTH-stale, keyed off the [[okf-slice]] link', async () => {
    await writeMemory(DIR, 'flaky', [
      block('flaky', 'alpha', 3, 'runner'),
      block('flaky', 'beta', 2, 'observe'),
    ]);
    await seedOkf(DIR, ['runner', 'observe']);

    // Inject a fake gate: HEALTH-stale (exit 1) for `runner` only, fresh (exit 0) for everything else.
    const runGate = (_mode: 'check' | 'write', _topics: string, keys: string[]): number =>
      keys.includes('runner') ? 1 : 0;

    const shifted = codeShiftedInjector(DIR, ['flaky'], { runGate });

    expect([...shifted].sort()).toEqual(['flaky::alpha']); // runner-linked sig retired
    expect(shifted.has('flaky::beta')).toBe(false); // observe-linked sig NOT retired
  });

  // TEST-THE-TEST is covered by the mutation notes in the report: (1) keying codeShifted off the node id
  // instead of the sig's link → beta enters the set → FAIL; (2) invert the gate boolean → alpha missing → FAIL.

  it('no OKF substrate ⇒ empty set (degrades silently, never throws)', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-compact-nosub-'));
    await writeMemory(bare, 'flaky', [block('flaky', 'alpha', 3, 'runner')]);
    const shifted = codeShiftedInjector(bare, ['flaky'], { runGate: () => 1 });
    expect(shifted.size).toBe(0);
    await fs.rm(bare, { recursive: true, force: true });
  });
});

describe('memory compact — the verb wires the injected sets into compactMemory (unconditional retire)', () => {
  let DIR: string;
  let out: string;
  const print = (s: string): void => void (out += s);
  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-compact-verb-'));
    out = '';
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test B — an injected `graduated` sig flows through the verb into CompactOpts.graduated and drives an
  // UNCONDITIONAL retire under the cap (the path cap-eviction can't reach). --apply mutates the live file.
  it('--apply retires an injected graduated lesson even under the cap; the sibling survives', async () => {
    const file = await writeMemory(DIR, 'flaky', [block('flaky', 'alpha', 5), block('flaky', 'beta', 2)]);
    const readGraduatedSigs = (): Set<string> => new Set(['flaky::alpha']);

    await runMemoryCompactCli([DIR, '--apply', '--max-lessons', '8', '--no-code-shifted'], {
      readGraduatedSigs,
      print,
    });

    const after = readFileSync(file, 'utf8');
    expect(after).not.toContain('sig: flaky::alpha'); // graduated ⇒ retired unconditionally (cap has slack)
    expect(after).toContain('sig: flaky::beta'); // the sibling is preserved verbatim
    expect(out).toMatch(/graduated/i); // the report names the reason
  });

  // TEST-THE-TEST for B is in the report: drop the graduated set from the compactMemory call → alpha survives
  // (under cap, no cap pressure) → this test FAILS.

  it('code-shifted flows end-to-end: an injected stale slice retires only its linked lesson', async () => {
    const file = await writeMemory(DIR, 'flaky', [
      block('flaky', 'alpha', 4, 'runner'),
      block('flaky', 'beta', 3, 'observe'),
    ]);
    await seedOkf(DIR, ['runner', 'observe']);
    const runGate = (_m: 'check' | 'write', _t: string, keys: string[]): number =>
      keys.includes('runner') ? 1 : 0;

    await runMemoryCompactCli([DIR, '--apply', '--max-lessons', '8', '--no-graduated'], { runGate, print });

    const after = readFileSync(file, 'utf8');
    expect(after).not.toContain('sig: flaky::alpha'); // runner-linked lesson retired (code-shifted)
    expect(after).toContain('sig: flaky::beta'); // observe-linked lesson kept
    expect(out).toMatch(/code-shifted/i);
  });
});

describe('memory compact — DEFAULT dry-run mutates nothing', () => {
  let DIR: string;
  let out: string;
  const print = (s: string): void => void (out += s);
  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-compact-dry-'));
    out = '';
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test C — without --apply the verb REPORTS the retire plan but leaves memory.md byte-identical on disk.
  it('reports the retire plan but leaves the live file byte-for-byte unchanged', async () => {
    const file = await writeMemory(DIR, 'flaky', [block('flaky', 'alpha', 5), block('flaky', 'beta', 2)]);
    const before = readFileSync(file, 'utf8');
    const readGraduatedSigs = (): Set<string> => new Set(['flaky::alpha']);

    await runMemoryCompactCli([DIR, '--max-lessons', '8', '--no-code-shifted'], {
      readGraduatedSigs,
      print,
    });

    expect(readFileSync(file, 'utf8')).toBe(before); // NOT written — dry-run is the default
    expect(out).toMatch(/flaky::alpha/); // but the plan still names what WOULD retire
    expect(out).toMatch(/dry-run|--apply/i); // and signals it wrote nothing
  });

  // TEST-THE-TEST for C is in the report: make dry-run call compactMemory on the live file → the file changes
  // → this test FAILS.
});

describe('memory compact — degradation: both injectors empty, cap-eviction still runs, never throws', () => {
  let DIR: string;
  let out: string;
  const print = (s: string): void => void (out += s);
  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-compact-degrade-'));
    out = '';
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test D — no OKF substrate + no graduated reader available: both injectors return ∅ and the verb still
  // runs cap-eviction only, never throwing. Asserts the never-throw posture.
  it('with no OKF substrate and disabled graduated, cap-eviction alone runs over the cap', async () => {
    const file = await writeMemory(DIR, 'flaky', [
      block('flaky', 'alpha', 3),
      block('flaky', 'beta', 1),
      block('flaky', 'gamma', 2),
    ]);

    await runMemoryCompactCli([DIR, '--apply', '--max-lessons', '2', '--no-graduated', '--no-code-shifted'], {
      print,
    });

    const after = readFileSync(file, 'utf8');
    expect(after).not.toContain('sig: flaky::beta'); // the recurrence-1 block is cap-evicted
    expect(after).toContain('sig: flaky::alpha'); // higher-recurrence survivors kept
    expect(after).toContain('sig: flaky::gamma');
  });
});

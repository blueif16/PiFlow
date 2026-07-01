import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMemoryFind, runMemoryCheck } from '../src/memory.js';

// `piflowctl memory find|check` promote the already-built Leg-A recurrence engine (`deriveRecurrence`) into a
// deterministic CLI verb (mirroring `understand`). `find` folds the counted recurrence index into a printed
// report for the out-of-band triage/fixer ("has this node failed THIS way before, how often, what did we
// learn?"). `check` RIDES the OKF `--check` gate through each lesson's `[[okf-slice]]` pointer, advisory by
// default. Both are strictly READ-ONLY — no model, no network, no mutation. These tests pin the observable
// surfaced signal (recurrence count + prevention prose + the linked slice key), each with a mutation that
// makes it fail when the code is wrong.

// A real lesson block in the per-node grammar (recurrence.ts:12-20): `### heading` opens it; `sig:` is the
// machine key; `recurrence:` the cross-run count; `[[slice]]` the code-map pointer; Root/Prevention the prose.
const buildLesson = [
  '### build wrote no artifact',
  'sig: build::no-artifact',
  'recurrence: 3',
  '[[runner]]',
  '**Root:** the prompt never named the output path',
  '**Prevention:** always echo the artifact path in the final turn',
  '',
].join('\n');

const systemLesson = [
  '### system-wide stall',
  'sig: system::stall',
  'recurrence: 1',
  '**Root:** a downstream node blocked on a missing dep',
  '',
].join('\n');

describe('memory find — surfaces a node’s counted standing lessons for triage', () => {
  let DIR: string;
  let out = '';
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-memory-find-'));
    await fs.mkdir(path.join(DIR, 'nodes', 'build'), { recursive: true });
    await fs.writeFile(path.join(DIR, 'nodes', 'build', 'memory.md'), buildLesson);
    await fs.writeFile(path.join(DIR, 'memory.md'), systemLesson);
    out = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
  });
  afterEach(async () => {
    outSpy.mockRestore();
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test 1 — the load-bearing read: the parsed count + prevention prose + the linked slice reach triage.
  it('surfaces the sig, its recurrence count, the [[okf-slice]] pointer, and the prevention prose', async () => {
    await runMemoryFind([DIR, '--node', 'build']);
    expect(out).toContain('build::no-artifact');
    expect(out).toContain('recurrence: 3'); // the ACTUAL parsed count, not a constant
    expect(out).toContain('always echo the artifact path'); // the prevention prose reached triage
    expect(out).toContain('runner'); // the [[okf-slice]] pointer surfaced
  });

  it('bare find (no --node) discovers every node dir AND the system lessons', async () => {
    await runMemoryFind([DIR]);
    expect(out).toContain('build::no-artifact');
    expect(out).toContain('system::stall'); // the system-level memory.md is folded in too
  });

  it('a <symptom> query filters the index to matching signatures (case-insensitive substring)', async () => {
    await runMemoryFind([DIR, 'no-artifact']);
    expect(out).toContain('build::no-artifact');
    expect(out).not.toContain('system::stall'); // filtered out — its sig has no "no-artifact"
  });

  it('an empty template reports zero standing lessons honestly (never invents)', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-memory-empty-'));
    await runMemoryFind([empty, '--node', 'ghost']);
    expect(out).toMatch(/no standing lessons|recurrence 0|first occurrence/i);
    expect(out).not.toContain('build::no-artifact');
    await fs.rm(empty, { recursive: true, force: true });
  });

  it('a missing templateDir positional errors (exit != 0), never reads', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    process.exitCode = 0;
    try {
      await runMemoryFind([]);
    } finally {
      errSpy.mockRestore();
    }
    expect(Number(process.exitCode ?? 0)).not.toBe(0);
    process.exitCode = 0;
  });
});

describe('memory check — rides the OKF gate through each lesson’s [[okf-slice]] link (advisory)', () => {
  let DIR: string;
  let topics: string;
  let out = '';
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-memory-check-'));
    // The OKF substrate lives up the tree from the templateDir; the lesson links [[runner]].
    topics = path.join(DIR, '.agents', 'okf', 'topics');
    await fs.mkdir(topics, { recursive: true });
    await fs.writeFile(path.join(topics, '_generate.mjs'), '// engine\n');
    await fs.writeFile(
      path.join(topics, 'runner.md'),
      ['---', 'key: runner', 'title: Runner spine', '---', '', 'how the runner works.', ''].join('\n'),
    );
    await fs.mkdir(path.join(DIR, 'nodes', 'build'), { recursive: true });
    await fs.writeFile(path.join(DIR, 'nodes', 'build', 'memory.md'), buildLesson);
    out = '';
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => ((out += String(c)), true));
    process.exitCode = 0;
  });
  afterEach(async () => {
    outSpy.mockRestore();
    process.exitCode = 0;
    await fs.rm(DIR, { recursive: true, force: true });
  });

  // LB test 2 — the gate is called on the EXTRACTED lesson slice (not a blanket key list); a HEALTH-failure
  // (gate returns non-zero) flags that lesson code-shifted; advisory by default (exit 0).
  it('rides the gate on the lesson’s LINKED slice and flags a code-shifted lesson (advisory: exit 0)', async () => {
    const calls: Array<{ mode: string; keys: string[] }> = [];
    const runGate = (mode: 'check' | 'write', _dir: string, keys: string[]): number => {
      calls.push({ mode, keys });
      return 1; // simulate the slice failing --check (HEALTH failure)
    };
    await runMemoryCheck([DIR], { cwd: DIR, runGate });

    expect(calls[0].mode).toBe('check');
    expect(calls[0].keys).toContain('runner'); // rode the gate on the LINKED slice, not all slices
    expect(out).toMatch(/code-shifted|stale/i); // the failing slice's lesson is flagged
    expect(Number(process.exitCode ?? 0)).toBe(0); // ADVISORY by default (parity with understand)
  });

  it('a fresh slice (gate returns 0) is reported fresh, no code-shift flag', async () => {
    const runGate = (): number => 0;
    await runMemoryCheck([DIR], { cwd: DIR, runGate });
    expect(out).toMatch(/fresh|ok|up to date/i);
    expect(out).not.toMatch(/code-shifted/i);
    expect(Number(process.exitCode ?? 0)).toBe(0);
  });

  it('--strict turns a code-shifted lesson into a non-zero exit (for a pre-commit hook)', async () => {
    const runGate = (): number => 1; // slice HEALTH failure
    await runMemoryCheck([DIR, '--strict'], { cwd: DIR, runGate });
    expect(Number(process.exitCode ?? 0)).not.toBe(0);
    process.exitCode = 0;
  });

  it('no .agents/okf substrate → the freshness gate is skipped, advisory exit 0', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-memory-nosub-'));
    await fs.mkdir(path.join(bare, 'nodes', 'build'), { recursive: true });
    await fs.writeFile(path.join(bare, 'nodes', 'build', 'memory.md'), buildLesson);
    const gateSpy = vi.fn(() => 0);
    await runMemoryCheck([bare], { cwd: bare, runGate: gateSpy });
    expect(gateSpy).not.toHaveBeenCalled(); // no substrate ⇒ no ride-along gate
    expect(out).toMatch(/no .agents\/okf|skipped|no substrate/i);
    expect(Number(process.exitCode ?? 0)).toBe(0);
    await fs.rm(bare, { recursive: true, force: true });
  });
});

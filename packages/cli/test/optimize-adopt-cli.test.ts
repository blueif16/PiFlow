// Contract for the `piflowctl optimize --adopt <manifest> [--dry-run] [--backup-dir <d>]` verb — the physical
// LAND step (piflow-memory-v1.5 §6). A PURE, DETERMINISTIC replay of a recorded decision: it reads a staging
// manifest, selects landed==='adopted' records, and drives core's adoptFromManifest to overwrite the live
// file(s) from the candidate copy (backup-first). It loads NO binding, calls NO oracle/fixer/model, does no
// scoring — landing is the explicit, opt-in, OUT-OF-LOOP step, never a side effect of --fix/--rounds.
//
// Tested at the level the verb adds: arg-parse, the manifest read → drive → summary, --dry-run (lands nothing),
// and the exit codes (2 on a missing/malformed manifest). The physical adopt itself is covered in core.
//
// Run: npx vitest run packages/cli/test/optimize-adopt-cli.test.ts

import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOptimizeAdoptArgs, runOptimizeAdoptCli } from '../src/optimize-adopt.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'optadopt-'));

// process.exitCode leaks across tests — reset it after each so one verb's exit code can't bleed into the next.
afterEach(() => { process.exitCode = 0; });

/**
 * Lay out a real staging tree: a live file, a candidate copy, and a manifest.json whose one adopted record maps
 * candidate→live. Returns the paths the assertions read (the manifest is what the verb consumes).
 */
const seedManifest = async (landed = 'adopted') => {
  const dir = await tmp();
  const live = path.join(dir, 'live', 'node');
  const cand = path.join(dir, 'cand');
  await fs.mkdir(live, { recursive: true });
  await fs.mkdir(cand, { recursive: true });
  await fs.writeFile(path.join(live, 'hook.ts'), 'OLD');
  await fs.writeFile(path.join(cand, 'hook.ts'), 'NEW');
  const manifestPath = path.join(dir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify({
    summary: { attempted: 1, accepted: 1, stoppedReason: 'complete' },
    records: [{ node: 'node', bucket: 'FUNCTIONALITY', landed, editsApplied: 1, tokensSpent: 0, candidateRef: cand, liveRoot: live, reason: '', delta: 1, landPolicy: 'auto-adopt-eligible' }],
  }, null, 2));
  return { dir, live, cand, manifestPath };
};

describe('parseOptimizeAdoptArgs', () => {
  it('parses the manifest positional, --dry-run, and --backup-dir', () => {
    const a = parseOptimizeAdoptArgs(['--adopt', '/tmp/m/manifest.json', '--dry-run', '--backup-dir', '/tmp/bk']);
    expect(a.manifest).toBe('/tmp/m/manifest.json');
    expect(a.dryRun).toBe(true);
    expect(a.backupDir).toBe('/tmp/bk');
  });

  it('defaults dry-run OFF and leaves backup-dir unset when not given', () => {
    const a = parseOptimizeAdoptArgs(['--adopt', '/tmp/m/manifest.json']);
    expect(a.dryRun).toBe(false);
    expect(a.backupDir).toBeUndefined();
  });
});

describe('runOptimizeAdoptCli — reads the manifest and drives the physical adopt', () => {
  it('physically lands the adopted record live (backup-first) and prints a summary with the adopted count', async () => {
    const { live, manifestPath } = await seedManifest();
    const lines: string[] = [];
    await runOptimizeAdoptCli(['--adopt', manifestPath], { print: (s) => lines.push(s) });

    // the live file now carries the candidate bytes.
    expect(await fs.readFile(path.join(live, 'hook.ts'), 'utf8')).toBe('NEW');
    // the summary reports the adopted count (observe the number, never the exact wording).
    expect(lines.join('\n')).toMatch(/1/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('--dry-run lands NOTHING (the live file is unchanged) but still reports what WOULD land', async () => {
    const { live, manifestPath } = await seedManifest();
    const lines: string[] = [];
    await runOptimizeAdoptCli(['--adopt', manifestPath, '--dry-run'], { print: (s) => lines.push(s) });

    // the live file keeps its original bytes — nothing was written.
    expect(await fs.readFile(path.join(live, 'hook.ts'), 'utf8')).toBe('OLD');
    // but the report still surfaces the file that WOULD land.
    expect(lines.join('\n')).toMatch(/hook\.ts/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('a missing manifest path sets exitCode 2 and prints an actionable error (loads/lands nothing)', async () => {
    const dir = await tmp();
    const missing = path.join(dir, 'nope', 'manifest.json');
    const errs: string[] = [];
    await runOptimizeAdoptCli(['--adopt', missing], { print: () => {}, printErr: (s) => errs.push(s) });

    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/manifest/i);
  });

  it('no manifest argument sets exitCode 2 with an actionable error', async () => {
    const errs: string[] = [];
    await runOptimizeAdoptCli(['--adopt'], { print: () => {}, printErr: (s) => errs.push(s) });
    expect(process.exitCode).toBe(2);
    expect(errs.join('\n')).toMatch(/manifest/i);
  });
});

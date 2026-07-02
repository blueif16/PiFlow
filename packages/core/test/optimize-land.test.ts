// Contract for optimize/land.ts — the LAND seam (v1.5 §6: "LAND = a staging dir + a manifest"; auto-land
// only when gate-accepted AND the auto_adopt flag is set, else an explicit human adopt that BACKS UP before
// overwriting). Two bounded fs operations:
//   • writeStagingManifest(result, {stagingDir}) → writes <stagingDir>/manifest.json (the durable record).
//   • adoptFile(live, candidate, {backupDir}) → BACKS UP the live file, then overwrites it from the candidate.
//
// Run: npx vitest run packages/core/test/optimize-land.test.ts

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStagingManifest, adoptFile, adoptFromManifest } from '../src/optimize/land.js';
import type { FixGateResult } from '../src/optimize/driver.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-land-'));

const result: FixGateResult = {
  attempted: 2, accepted: 1, stoppedReason: 'complete',
  records: [
    { node: 'w4-execute-m2', bucket: 'FUNCTIONALITY', candidateRef: 'cand:w4-execute-m2', liveRoot: 'live/w4-execute-m2', editsApplied: 1, landed: 'staged', tokensSpent: 10,
      verdict: { accept: true, reason: 'strict improvement (+1)', delta: 1, landPolicy: 'auto-adopt-eligible' } },
    { node: 'flaky', bucket: 'LAPSE', candidateRef: 'cand:flaky', liveRoot: '', editsApplied: 1, landed: 'discarded', tokensSpent: 4,
      verdict: { accept: false, reason: 'no strict improvement (candidate 0.4 ≤ base 0.5)', delta: -0.1, landPolicy: 'auto-adopt-eligible' } },
  ],
};

describe('writeStagingManifest', () => {
  it('writes a parseable manifest.json capturing the summary + per-record decisions', async () => {
    const dir = await tmp();
    const manifestPath = await writeStagingManifest(result, { stagingDir: dir });
    expect(manifestPath).toBe(path.join(dir, 'manifest.json'));
    const m = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    expect(m.summary).toMatchObject({ attempted: 2, accepted: 1, stoppedReason: 'complete' });
    expect(m.records).toHaveLength(2);
    const m2 = m.records.find((r: { node: string }) => r.node === 'w4-execute-m2');
    expect(m2.landed).toBe('staged');
    expect(m2.bucket).toBe('FUNCTIONALITY');
  });
});

describe('adoptFile — backup before overwrite', () => {
  it('backs up the existing live file, then overwrites it from the candidate', async () => {
    const dir = await tmp();
    const live = path.join(dir, 'live', 'hook.ts');
    const candidate = path.join(dir, 'cand', 'hook.ts');
    const backupDir = path.join(dir, 'backups');
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(live, 'OLD');
    await fs.writeFile(candidate, 'NEW');

    const { backupPath } = await adoptFile(live, candidate, { backupDir });

    expect(await fs.readFile(live, 'utf8')).toBe('NEW'); // live now carries the candidate
    expect(backupPath).toBeTruthy();
    expect(await fs.readFile(backupPath, 'utf8')).toBe('OLD'); // the original is preserved
  });

  it('when there is no live file yet, it still writes the candidate (empty backupPath)', async () => {
    const dir = await tmp();
    const live = path.join(dir, 'live', 'new.ts');
    const candidate = path.join(dir, 'cand', 'new.ts');
    await fs.mkdir(path.dirname(candidate), { recursive: true });
    await fs.writeFile(candidate, 'FRESH');

    const { backupPath } = await adoptFile(live, candidate, { backupDir: path.join(dir, 'backups') });

    expect(await fs.readFile(live, 'utf8')).toBe('FRESH');
    expect(backupPath).toBe('');
  });
});

// ── adoptFromManifest — the physical LAND step: a pure, deterministic replay of the manifest's decisions ──────
// The verb `optimize --adopt` drives this. It selects landed==='adopted' records, walks each candidate dir, and
// overwrites the mirror live file (backup-first) via adoptFile. Load-bearing invariants under test: land ONLY
// adopted records (staged/discarded untouched), SKIP symlinks in the candidate (game-omni's copyScope symlinks
// node_modules/public/src/contract — overwriting the target corrupts live), degrade (never throw) a stale record,
// and re-run idempotently (the byte-equal skip preserves the FIRST backup, the true original).
describe('adoptFromManifest — physically land ONLY the adopted records, backup-first', () => {
  // Build a tmp tree: live/<node> + cand<Node> dirs with a single file each; return the roots the manifest needs.
  const seedTree = async () => {
    const dir = await tmp();
    const liveA = path.join(dir, 'live', 'nodeA');
    const liveB = path.join(dir, 'live', 'nodeB');
    const candA = path.join(dir, 'candA');
    const candB = path.join(dir, 'candB');
    await fs.mkdir(liveA, { recursive: true });
    await fs.mkdir(liveB, { recursive: true });
    await fs.mkdir(candA, { recursive: true });
    await fs.mkdir(candB, { recursive: true });
    await fs.writeFile(path.join(liveA, 'hook.ts'), 'OLD');
    await fs.writeFile(path.join(liveB, 'x.ts'), 'KEEP');
    await fs.writeFile(path.join(candA, 'hook.ts'), 'NEW');
    await fs.writeFile(path.join(candB, 'x.ts'), 'CHANGED');
    const backupDir = path.join(dir, 'backups');
    const manifest = {
      summary: { attempted: 2, accepted: 2, stoppedReason: 'complete' },
      records: [
        { node: 'nodeA', bucket: 'FUNCTIONALITY', landed: 'adopted', editsApplied: 1, tokensSpent: 0, candidateRef: candA, liveRoot: liveA, reason: '', delta: 1, landPolicy: 'auto-adopt-eligible' },
        { node: 'nodeB', bucket: 'LAPSE', landed: 'staged', editsApplied: 1, tokensSpent: 0, candidateRef: candB, liveRoot: liveB, reason: '', delta: 1, landPolicy: 'auto-adopt-eligible' },
      ],
    };
    return { dir, liveA, liveB, candA, candB, backupDir, manifest };
  };

  it('(load-bearing) lands the adopted record live, backs up the original, and leaves the staged record untouched', async () => {
    const { liveA, liveB, backupDir, manifest } = await seedTree();

    const report = await adoptFromManifest(manifest, { backupDir });

    // the ADOPTED record's file now carries the candidate bytes.
    expect(await fs.readFile(path.join(liveA, 'hook.ts'), 'utf8')).toBe('NEW');
    // the STAGED record's file is untouched (only adopted records land).
    expect(await fs.readFile(path.join(liveB, 'x.ts'), 'utf8')).toBe('KEEP');
    // backup-first: the original bytes are preserved.
    expect(await fs.readFile(path.join(backupDir, 'hook.ts.bak'), 'utf8')).toBe('OLD');
    // exactly one adopted entry (node A), nothing skipped-as-error.
    expect(report.adopted).toHaveLength(1);
    expect(report.adopted[0]).toMatchObject({ node: 'nodeA', file: 'hook.ts' });
  });

  it('SKIPS a symlinked candidate DIRECTORY — never descends it to overwrite live (copyScope symlinks node_modules/public/src/contract)', async () => {
    const { dir, liveA, candA, backupDir, manifest } = await seedTree();
    // copyScope real-copies editable src but SYMLINKS node_modules/public/src/contract (each a DIR). Model that:
    // a real dir 'realdep' with a file inside, and a symlink 'node_modules' → it, placed in the candidate scope.
    // If adopt DESCENDED the symlink (following the link via stat/Dirent instead of lstat), it would land
    // realdep/dep.ts onto liveA/node_modules/dep.ts — a phantom live file that corrupts the product. adopt MUST NOT.
    const realdep = path.join(dir, 'realdep');
    await fs.mkdir(realdep, { recursive: true });
    await fs.writeFile(path.join(realdep, 'dep.ts'), 'VENDORED');
    await fs.symlink(realdep, path.join(candA, 'node_modules'), 'dir');
    const wouldClobber = path.join(liveA, 'node_modules', 'dep.ts');

    const report = await adoptFromManifest(manifest, { backupDir });

    // NOTHING was written through the symlink (the real vendored file is untouched; no phantom live file appeared).
    expect(await exists(wouldClobber)).toBe(false);
    expect(await fs.readFile(path.join(realdep, 'dep.ts'), 'utf8')).toBe('VENDORED');
    // the REAL copied file still landed (skipping the symlink didn't abort the record).
    expect(await fs.readFile(path.join(liveA, 'hook.ts'), 'utf8')).toBe('NEW');
    // only the real file is in the adopted set — the symlinked dir's contents never entered the walk.
    expect(report.adopted.map((a) => a.file)).toEqual(['hook.ts']);
    expect(report.errors).toHaveLength(0);
  });

  it('degrades a record with an empty liveRoot or a missing candidate dir into `skipped` — never throws', async () => {
    const { manifest, backupDir, dir } = await seedTree();
    // record A: empty liveRoot (the binding injected no liveRootFor → not landable deterministically).
    manifest.records[0].liveRoot = '';
    // record B: flip to adopted but point candidateRef at a dir that does not exist.
    manifest.records[1].landed = 'adopted';
    manifest.records[1].candidateRef = path.join(dir, 'does-not-exist');

    const report = await adoptFromManifest(manifest, { backupDir });

    expect(report.adopted).toHaveLength(0);
    expect(report.skipped).toHaveLength(2);
    expect(report.skipped.map((s) => s.node).sort()).toEqual(['nodeA', 'nodeB']);
  });

  it('re-running on the same manifest preserves the FIRST backup (byte-equal skip) — the true original survives', async () => {
    const { liveA, backupDir, manifest } = await seedTree();

    await adoptFromManifest(manifest, { backupDir }); // run 1: OLD → backup, NEW → live
    await adoptFromManifest(manifest, { backupDir }); // run 2: live already == candidate → skip (don't re-backup)

    // the backup STILL holds the true original — NOT the already-adopted 'NEW' (which run 2 would capture without the skip).
    expect(await fs.readFile(path.join(backupDir, 'hook.ts.bak'), 'utf8')).toBe('OLD');
    expect(await fs.readFile(path.join(liveA, 'hook.ts'), 'utf8')).toBe('NEW');
  });

  it('--dry-run reports what WOULD land but touches no live file or backup', async () => {
    const { liveA, backupDir, manifest } = await seedTree();

    const report = await adoptFromManifest(manifest, { backupDir, dryRun: true });

    // nothing landed: the live file keeps its original bytes, no backup was written.
    expect(await fs.readFile(path.join(liveA, 'hook.ts'), 'utf8')).toBe('OLD');
    expect(await exists(path.join(backupDir, 'hook.ts.bak'))).toBe(false);
    // but the report still lists what WOULD land.
    expect(report.adopted).toHaveLength(1);
    expect(report.adopted[0]).toMatchObject({ node: 'nodeA', file: 'hook.ts' });
  });
});

/** Local exists helper for the assertions above (adoptFile's is private). */
async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

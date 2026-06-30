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
import { writeStagingManifest, adoptFile } from '../src/optimize/land.js';
import type { FixGateResult } from '../src/optimize/driver.js';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-land-'));

const result: FixGateResult = {
  attempted: 2, accepted: 1, stoppedReason: 'complete',
  records: [
    { node: 'w4-execute-m2', bucket: 'FUNCTIONALITY', candidateRef: 'cand:w4-execute-m2', editsApplied: 1, landed: 'staged', tokensSpent: 10,
      verdict: { accept: true, reason: 'strict improvement (+1)', delta: 1, landPolicy: 'auto-adopt-eligible' } },
    { node: 'flaky', bucket: 'LAPSE', candidateRef: 'cand:flaky', editsApplied: 1, landed: 'discarded', tokensSpent: 4,
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

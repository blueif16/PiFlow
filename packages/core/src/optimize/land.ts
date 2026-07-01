// optimize/land.ts — the LAND seam (v1.5 §6: "LAND = a staging dir + a manifest"). Two bounded fs ops:
// writeStagingManifest (the durable record of a round's decisions) and adoptFile (backup-then-overwrite the
// live file from a candidate copy — the explicit human/auto adopt). Nothing here decides; the driver's
// manifest decided. Keeping the physical fs mutation HERE (not in driver.ts) preserves "the loop never
// mutates the live file" — adoption is a separate, explicit, backed-up step.
//
// Two invariants this module physically enforces:
//   • DURABLE & DETERMINISTIC — the manifest is the round's verifiable record (no timestamp/random, so
//     identical decisions render identical bytes), flattening each verdict's reason/delta/landPolicy beside
//     the decision so a reader needn't re-derive the gate.
//   • BACKS UP before overwriting — adopt copies the live file aside (<basename>.bak) before clobbering it,
//     so an adopt is always reversible; a missing live file is the NEW-FILE branch (just place the candidate),
//     never an error.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FixGateResult } from './driver.js';

export interface StageOpts {
  stagingDir: string;
}

/** The durable per-record row: the driver's decision + the flattened gate verdict (reason/delta/landPolicy). */
interface ManifestRecord {
  node: string;
  bucket: string;
  landed: string;
  editsApplied: number;
  tokensSpent: number;
  candidateRef: string;
  reason: string;
  delta: number | null;
  landPolicy: string;
  /** the fixer's traced root cause, when it reported one — a durable, human-readable record even absent a distiller. */
  foundRoot?: string;
}

/** Write `<stagingDir>/manifest.json` capturing the round's summary + per-record decisions. Returns its path. */
export async function writeStagingManifest(result: FixGateResult, opts: StageOpts): Promise<string> {
  const manifestPath = path.join(opts.stagingDir, 'manifest.json');

  const records: ManifestRecord[] = result.records.map((r) => ({
    node: r.node,
    bucket: r.bucket,
    landed: r.landed,
    editsApplied: r.editsApplied,
    tokensSpent: r.tokensSpent,
    candidateRef: r.candidateRef,
    reason: r.verdict.reason,
    delta: r.verdict.delta,
    landPolicy: r.verdict.landPolicy,
    // durable record of what the fixer traced (conditional so the manifest stays byte-identical when unset).
    ...(r.foundRoot ? { foundRoot: r.foundRoot } : {}),
  }));

  const manifest = {
    summary: {
      attempted: result.attempted,
      accepted: result.accepted,
      stoppedReason: result.stoppedReason,
    },
    records,
  };

  await fs.mkdir(opts.stagingDir, { recursive: true });
  // Deterministic content — no timestamp/random, so equal decisions render equal bytes.
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

/** Does `p` exist on disk? A missing live file is the new-file branch, not an error. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Back up the live file (if present) into backupDir, then overwrite it from the candidate. Returns the backup path ('' if none). */
export async function adoptFile(livePath: string, candidatePath: string, opts: { backupDir: string }): Promise<{ backupPath: string }> {
  // NEW-FILE branch: no live file to preserve — just place the candidate, nothing to back up.
  if (!(await exists(livePath))) {
    await fs.mkdir(path.dirname(livePath), { recursive: true });
    await fs.copyFile(candidatePath, livePath);
    return { backupPath: '' };
  }

  // ADOPT branch: copy the live file aside (stable <basename>.bak) BEFORE clobbering — adopts stay reversible.
  await fs.mkdir(opts.backupDir, { recursive: true });
  const backupPath = path.join(opts.backupDir, `${path.basename(livePath)}.bak`);
  await fs.copyFile(livePath, backupPath);
  await fs.copyFile(candidatePath, livePath);
  return { backupPath };
}

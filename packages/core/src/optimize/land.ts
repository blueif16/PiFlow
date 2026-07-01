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
  /**
   * The LIVE root the candidate copy mirrors (product-computed, injected via the driver's `liveRootFor`). `--adopt`
   * maps each candidate file onto `<liveRoot>/<relPath>` — the reverse of copyScope. Empty string ('') when the
   * binding injected no resolver: the record is then NOT landable deterministically, so `--adopt` SKIPS it (a stale
   * manifest degrades, never crashes). Core only STORES the string; it never computes a product path (boundary law).
   */
  liveRoot: string;
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
    // the LIVE root the candidate mirrors, so `--adopt` can map candidate→live deterministically. Defaults to ''
    // (from the driver) when the binding injected no `liveRootFor` — then the record is not landable and adopt skips.
    liveRoot: r.liveRoot,
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

// ── adoptFromManifest — the physical LAND step (`optimize --adopt` drives this) ───────────────────────────────
// A PURE, DETERMINISTIC replay of a recorded decision: it loads no binding, calls no oracle/fixer/model, does no
// scoring. It selects the manifest's landed==='adopted' records and, for each, walks the candidate dir and lands
// every REAL file onto its mirror under liveRoot via adoptFile (backup-first). "The model proposes/scores;
// deterministic code decides/bounds/LANDS" — this is the LANDS half made concrete, entirely in code.

/** The just-enough shape adoptFromManifest reads (a superset lives in the on-disk manifest; extra keys are ignored). */
export interface AdoptManifest {
  records: { node: string; landed: string; candidateRef: string; liveRoot: string }[];
}

/** Per-run outcome: what landed, what degraded (empty liveRoot / stale dir / a symlink), and what threw mid-run. */
export interface AdoptReport {
  /** each real file landed (or, under dryRun, that WOULD land). `backupPath` is '' for a new-file / dry-run. */
  adopted: { node: string; file: string; backupPath: string }[];
  /** a whole record that could not be landed deterministically (never a throw — a stale manifest degrades). */
  skipped: { node: string; reason: string }[];
  /** a per-file adopt that threw (e.g. a permission error) — reported, never swallowed (partial-land integrity). */
  errors: { node: string; file: string; message: string }[];
}

/** Are two files byte-equal? Used to make a re-adopt a no-op AND preserve the FIRST backup (the true original). */
async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [ba, bb] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return ba.equals(bb);
  } catch {
    return false;
  }
}

/**
 * Walk `root` recursively, yielding each REAL file's path relative to `root`. SYMLINKS ARE SKIPPED (load-bearing):
 * copyScope real-copies editable src but SYMLINKS node_modules/public/src/contract — following one would let adopt
 * clobber the symlink's live target (corrupting the product). We only ever land real copied files. Uses lstat (never
 * follows the link) so a symlinked file OR dir is skipped without descending into it.
 */
async function walkRealFiles(root: string, rel = ''): Promise<string[]> {
  const dir = path.join(root, rel);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a missing candidate dir yields no files — the caller degrades the record to `skipped`.
  }
  const files: string[] = [];
  for (const e of entries) {
    const childRel = path.join(rel, e.name);
    // lstat, not the Dirent flags: readdir's isSymbolicLink is reliable, but lstat keeps the intent explicit and
    // handles a link whose type Dirent couldn't classify. A symlink (to a file OR a dir) is skipped outright.
    const st = await fs.lstat(path.join(root, childRel));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) files.push(...(await walkRealFiles(root, childRel)));
    else if (st.isFile()) files.push(childRel);
  }
  return files;
}

/**
 * Physically land the manifest's `adopted` records. For each, walk its candidateRef (real files only) and for every
 * file call adoptFile(<liveRoot>/<rel>, <candidateRef>/<rel>, {backupDir}) — backup-first, reversible. A record with
 * an empty liveRoot or a missing/empty candidate dir goes to `skipped` (never a throw). A file already byte-equal to
 * the live copy is SKIPPED (re-runs are no-ops AND the first backup — the true original — survives). `dryRun` reports
 * what WOULD land without touching disk. A per-file throw is recorded in `errors` and the run continues (partial-land
 * is reported, never swallowed; the backups ARE the recovery path). Pure fs — product-agnostic, belongs in core.
 */
export async function adoptFromManifest(manifest: AdoptManifest, opts: { backupDir: string; dryRun?: boolean }): Promise<AdoptReport> {
  const report: AdoptReport = { adopted: [], skipped: [], errors: [] };
  const accepted = manifest.records.filter((r) => r.landed === 'adopted');

  for (const r of accepted) {
    if (!r.liveRoot) { // no injected liveRootFor → not landable deterministically.
      report.skipped.push({ node: r.node, reason: 'no liveRoot recorded (binding injected no liveRootFor)' });
      continue;
    }
    const files = await walkRealFiles(r.candidateRef);
    if (files.length === 0) { // a missing/empty candidate dir (a stale manifest) degrades, never crashes.
      report.skipped.push({ node: r.node, reason: `candidate dir missing or empty: ${r.candidateRef}` });
      continue;
    }
    for (const rel of files) {
      const livePath = path.join(r.liveRoot, rel);
      const candidatePath = path.join(r.candidateRef, rel);
      // idempotency: an already-identical live file is skipped — re-runs are no-ops AND the first backup survives.
      if (await sameBytes(livePath, candidatePath)) continue;
      if (opts.dryRun) { report.adopted.push({ node: r.node, file: rel, backupPath: '' }); continue; }
      try {
        const { backupPath } = await adoptFile(livePath, candidatePath, { backupDir: opts.backupDir });
        report.adopted.push({ node: r.node, file: rel, backupPath });
      } catch (e) {
        report.errors.push({ node: r.node, file: rel, message: (e as Error).message });
      }
    }
  }
  return report;
}

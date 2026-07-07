// P6 — mid-run migration primitives (the SkyPilot managed-jobs model: freeze → bundle → reload+resume,
// NOT live teleport). This module owns the two host-agnostic pieces the runner + CLI + server share:
//
//   1. FREEZE signalling — a `.pi/freeze` sentinel file. A `POST /freeze` (or `context migrate`) writes it;
//      the LIVE runner polls it at each stage boundary (runner.ts) and, when present, quiesces + parks the
//      run (`RunStatus.frozen`). The file IS the cross-process signal (no shared memory between the two
//      runners), mirroring the checkpoint-reply-file convention.
//   2. The default freeze SEAM — `defaultFreezeSignal(outDir)` returns the file-watch predicate the runner
//      uses when a caller doesn't inject its own (tests inject a deterministic function).
//
// The run-dir BUNDLE pack/unpack (piece 2 of P6) lands alongside these in a later step; kept in one module
// so the freeze signal and the bundle share a home the runner/server/CLI all import.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { piDir } from './layout.js';

/** `${run}/.pi/freeze` — the freeze sentinel. Its mere existence parks the run at the next stage boundary. */
export const freezeFile = (run: string): string => path.join(piDir(run), 'freeze');

/** Request a freeze (what `POST /freeze` / `context migrate` does): drop the sentinel into the run-dir. */
export async function requestFreeze(run: string): Promise<void> {
  await fs.mkdir(piDir(run), { recursive: true });
  await fs.writeFile(freezeFile(run), new Date().toISOString());
}

/** Clear the freeze sentinel (the resumed runner clears it on startup so it doesn't re-park immediately). */
export async function clearFreeze(run: string): Promise<void> {
  await fs.rm(freezeFile(run), { force: true });
}

/**
 * The default freeze predicate the runner uses when no `freezeSignal` is injected: park iff the sentinel
 * exists. A synchronous `existsSync` — a single cheap stat per stage boundary, so a non-migrating run pays
 * essentially nothing.
 */
export function defaultFreezeSignal(run: string): () => boolean {
  return () => existsSync(freezeFile(run));
}

// ── the run-dir BUNDLE (piece 2 of P6) ─────────────────────────────────────────────────────────────
// A migration ships the durable run-dir snapshot laptop⇄cloud, and the target reloads it before resuming
// via the journal. The snapshot is the WHOLE run-dir (journal + state + run.json + workflow.json + every
// produced artifact + warm sessions) MINUS the host-local coordination sentinels — so nothing regenerable
// is lost, but the lease/freeze files (which are per-HOST, not per-RUN) never travel. Format: a gzipped
// JSON manifest `{ version, files: { relPath: base64 } }` — dependency-free (node:zlib is built-in), and
// fine for the small, text-heavy run-dirs a control plane produces (swap the serializer if artifacts grow).

/**
 * Run-dir entries that must NEVER be bundled — they are HOST-LOCAL coordination state, not portable run
 * state. `run.lock` would make the target think it's already locked; `freeze` would make it re-park the
 * instant it resumes. Everything else in the run-dir travels.
 */
export const BUNDLE_EXCLUDE: string[] = ['.pi/run.lock', '.pi/freeze'];

/** The bundle version — bump if the manifest shape changes. */
const BUNDLE_VERSION = 1;

interface BundleDoc {
  version: number;
  files: Record<string, string>; // relPath (posix) → base64 of the file bytes
}

export interface PackOpts {
  /** Relative paths (posix) to skip, in addition to `BUNDLE_EXCLUDE`. */
  exclude?: string[];
}

/** Recursively list every file under `root` as posix-relative paths. */
async function listFiles(root: string, rel = ''): Promise<string[]> {
  const dir = rel ? path.join(root, rel) : root;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(root, childRel)));
    else if (e.isFile()) out.push(childRel);
  }
  return out;
}

/**
 * Pack a run-dir into a single gzipped bundle buffer (the portable migration snapshot). Excludes the
 * host-local coordination sentinels (`BUNDLE_EXCLUDE`) plus any caller-supplied paths.
 */
export async function packRunDir(run: string, opts: PackOpts = {}): Promise<Buffer> {
  const exclude = new Set([...BUNDLE_EXCLUDE, ...(opts.exclude ?? [])]);
  const files: Record<string, string> = {};
  for (const rel of await listFiles(run)) {
    if (exclude.has(rel)) continue;
    files[rel] = (await fs.readFile(path.join(run, rel))).toString('base64');
  }
  const doc: BundleDoc = { version: BUNDLE_VERSION, files };
  return gzipSync(Buffer.from(JSON.stringify(doc)));
}

export interface UnpackOpts {
  /**
   * Skip a dest that is ALREADY filled (exists with size > 0) instead of overwriting it — so a caller's
   * pre-placed file (a pin) survives the unpack. Default false: OVERWRITE (a migration reload wants the
   * bundle to win). `stageBaselineRun` passes true (a fork must never clobber a pin).
   */
  skipFilled?: boolean;
}

/**
 * Unpack a bundle buffer into `destRun`, recreating the directory tree. By default OVERWRITES existing files
 * (a migration reload). With `skipFilled`, an already-filled dest (size > 0) is left untouched — the seed
 * never clobbers a pre-placed pin. Returns the WRITTEN relative paths (a skipped dest is omitted). The caller
 * resumes via `runFromTemplate` (journal-driven) afterwards.
 */
export async function unpackRunDir(bundle: Buffer, destRun: string, opts: UnpackOpts = {}): Promise<string[]> {
  const doc = JSON.parse(gunzipSync(bundle).toString('utf8')) as BundleDoc;
  const written: string[] = [];
  for (const [rel, b64] of Object.entries(doc.files)) {
    const abs = path.join(destRun, rel);
    if (opts.skipFilled) {
      // Filled ⇒ a pin (or an earlier seed) already owns this dest — leave it VERBATIM.
      try {
        if ((await fs.stat(abs)).size > 0) continue;
      } catch {
        /* absent ⇒ not filled ⇒ write it below */
      }
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(b64, 'base64'));
    written.push(rel);
  }
  return written;
}

/**
 * The run-dir entries a BASELINE SEED must NOT carry: the JOURNAL — BOTH the primary `.pi/journal.json` AND
 * its fallback `.pi/journal.bak` (loadJournal reads the `.bak` when the primary is absent — journal.ts:275 —
 * so dropping only the primary would leave the seed with a live journal that marks the windowed node `reused`
 * unless its output happens to be deleted). Without any journal the windowed re-run has no reuse entry for the
 * node(s) under test and unconditionally re-runs (journal.ts) — while the `--from`-pinned upstream prefix
 * stays force-`reused`. Everything ELSE travels (artifacts + .pi/state.json + run.json + workflow.json + warm
 * sessions) so the reused upstream is frozen ON DISK, exactly like `spawnChildRun`'s replay construction
 * relies on. (The host-local run.lock/freeze are dropped by `packRunDir`'s BUNDLE_EXCLUDE.)
 */
export const BASELINE_SEED_EXCLUDE: string[] = ['.pi/journal.json', '.pi/journal.bak'];

export interface StageBaselineOpts {
  /** Relative paths (posix) to skip, ON TOP of the journal + the host-local sentinels. */
  exclude?: string[];
  /** Skip an already-filled dest so a pre-placed pin survives. Default TRUE (a fork must never clobber a pin). */
  skipFilled?: boolean;
}

/**
 * SEED a fresh run dir from a COMPLETED baseline run's durable state, so a windowed `--from` re-run treats the
 * upstream closure as frozen-`reused` (its artifacts + promoted state are on disk) while the node(s) under
 * test re-run (their journal entry is deliberately dropped — `BASELINE_SEED_EXCLUDE`). This is the SAME
 * primitive `spawnChildRun` constructs a replay-from-node-start with — bundle(baseline − journal − host
 * sentinels) → unpack — extracted so the `run --baseline` CLI path and `spawnChildRun` share ONE seed
 * implementation, never two. Skip-filled by default: a caller's pre-placed pin is never clobbered. Returns
 * the WRITTEN relative paths.
 */
export async function stageBaselineRun(
  baselineDir: string,
  destRun: string,
  opts: StageBaselineOpts = {},
): Promise<string[]> {
  const bundle = await packRunDir(baselineDir, { exclude: [...BASELINE_SEED_EXCLUDE, ...(opts.exclude ?? [])] });
  return unpackRunDir(bundle, destRun, { skipFilled: opts.skipFilled ?? true });
}

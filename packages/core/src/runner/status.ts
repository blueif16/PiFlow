// The run-status record — a future-viz-friendly mirror of the engine's run-status digest (run.mjs
// schema + writeStatus 639–668), now published as `.pi/run.json` (D7 layout) — kept faithful enough
// that a viz/dashboard can read it unchanged.
//
// The status is the SINGLE source of truth a watcher polls: a node is `ok` only when its declared
// artifacts exist ON DISK (the driver stat()s them — "verified, not trusted"). Because parallel lanes
// and the run loop all write this one file, the writer SERIALIZES writes per dir and publishes each
// ATOMICALLY (temp file + rename) so concurrent writers never interleave and a polling reader never
// sees a torn file (see writeStatus).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ReturnMode } from '../types.js';
import type { CheckResult } from '../checks.js';
import { piDir, runJsonFile } from './layout.js';

/** Per-node status enum (run.mjs ladder): the terminal verdict the driver assigns each node. */
export type NodeStatus =
  | 'pending'   // not yet run (selected window)
  | 'running'   // exec in flight
  | 'ok'        // clean exit + every declared artifact present
  | 'gap'       // self-reported non-fatal gap (honored from the node's return)
  | 'blocked'   // a required artifact is missing (contract breach) — beats any self-report
  | 'error'     // killed (timeout/stall) or nonzero exit / degenerate run
  | 'reused'    // skipped upstream node whose artifacts were reused (--from resume)
  | 'awaiting-input' // (G5) a human checkpoint is PARKED — its marker is pending, waiting for a reply
  | 'dry';      // dry-run: command built, not executed

/** One verified artifact: did it exist on the host after collection, and how big. */
export interface ArtifactState {
  path: string;
  exists: boolean;
  bytes: number;
}

/** A node's record in the run status. */
export interface NodeStatusRecord {
  id: string;
  label: string;
  status: NodeStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  artifacts: ArtifactState[];
  issues: string[];
  summary?: string;
  /** Set when a watchdog killed the node (classifies the `error`). */
  killedTimeout?: boolean;
  killedStall?: boolean;
  exitCode?: number;
  command?: string;
  /** Declarative integrity-check results (explicit ∪ auto fill-sentinel), when any were run. */
  checks?: CheckResult[];
  /** The effective return-handshake mode this node was judged under ('optional' | 'required'). */
  returnMode?: ReturnMode;
  /** Artifacts present but VIOLATING their declared schema (a contract breach → blocked). */
  schemaInvalid?: { path: string; errors: string[] }[];
  /** How many artifacts the schema gate actually validated. */
  schemaChecked?: number;
  /** Why the schema gate skipped (no validator / unreadable schema), if it did. */
  schemaSkipped?: string;
  /**
   * The node's structured RETURN violated its declared `returnSchema` (a contract breach). Mirrors
   * `schemaInvalid` for the return-handshake side: a present-but-NON-CONFORMING result blocks the node.
   */
  returnSchemaInvalid?: string[];
}

/** Run-level rollup at completion. */
export interface RunTotals {
  nodes: number;
  ok: number;
  failed: number;
}

/** The whole run-status record (faithful to run.mjs's shape for a future viz). */
export interface RunStatus {
  run: string;
  /**
   * The run's MEMORABLE identity — the Docker-style `<bake-adjective>-<pie>` name (e.g. "flaky-pecan")
   * the CLI mints when `--run/--id` is omitted, or the explicit `--run <id>` when one was passed. This
   * decouples a run's identity from any prompt id; absent on older records (additive, optional).
   */
  name?: string;
  /**
   * The originating prompt id, when the run carried one (`--arg prompt=<id>` / `--arg promptId=<id>`).
   * Carried as run METADATA so the run is traceable to its prompt WITHOUT the run id BEING the prompt id.
   */
  promptId?: string;
  source?: string;
  /** The active run PROFILE name (the reduced DAG this run reflects); null/absent ⇒ the full DAG. */
  profile?: string | null;
  provider?: string;
  model?: string | null;
  startedAt: string;
  updatedAt: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  /** While a stage runs: { index, total, nodes }. Null between/after stages. */
  stage: { index: number; total: number; nodeIds: string[] } | null;
  totals: RunTotals | null;
  nodes: Record<string, NodeStatusRecord>;
}

export const nowISO = (): string => new Date().toISOString();

// SERIALIZED + ATOMIC writer. The status file is the SINGLE source of truth a watcher polls (see the
// header), AND it is written from PARALLEL lanes (runWorkflow's per-stage Promise.all) plus the run
// loop — concurrent writers. Two hazards the naive `await fs.writeFile` has:
//   1. INTERLEAVING — two overlapping async writes to the SAME path are not ordered, so a later
//      `writeStatus` can land on disk BEFORE an earlier one's bytes finish, leaving a stale record
//      (run.mjs avoided this for free: it is single-threaded + synchronous `writeFileSync`).
//   2. TORN READS — `fs.writeFile` is not atomic; a concurrent reader (the viz/dashboard) can observe
//      a half-written, unparseable file (reproduced empirically: ~3/472 reads torn under load).
// Fix: a per-directory promise chain serializes writes (so they never overlap → last-write-wins is
// real), and each write goes to a unique temp file then `rename`s into place (atomic on POSIX/NTFS),
// so a reader sees only a complete prior or complete next file — never a partial one.
const writeChains = new Map<string, Promise<void>>();
let tmpSeq = 0;

/**
 * Write the run status to the CANONICAL `<dir>/.pi/run.json` (D7 layout; pretty-printed; mkdir -p the
 * `.pi/` namespace first). This IS the single source of truth the observe pipeline (readRunModel /
 * watchRun) and the cli/tui consumers poll — they read `runJsonFile(dir)`, the canonical `.pi/run.json`
 * digest. Writes to a given dir are SERIALIZED and each is ATOMIC (temp-file + rename in the
 * SAME `.pi/` dir, so the rename is intra-filesystem), so parallel lanes + a polling watcher never
 * interleave or read a torn file.
 */
export function writeStatus(dir: string, status: RunStatus): Promise<void> {
  status.updatedAt = nowISO();
  // SNAPSHOT the bytes NOW (synchronously), before queueing: `status` is a shared, still-mutating
  // object, so serializing only the file write is not enough — we must freeze WHAT this call writes at
  // call time, or a queued write would later serialize a future mutation and reorder records on disk.
  const body = JSON.stringify(status, null, 2);
  const prev = writeChains.get(dir) ?? Promise.resolve();
  const next = prev
    .catch(() => {}) // a prior write's failure must not poison the chain
    .then(async () => {
      const metaDir = piDir(dir);
      await fs.mkdir(metaDir, { recursive: true });
      const finalPath = runJsonFile(dir);
      const tmpPath = path.join(metaDir, `.run.${process.pid}.${tmpSeq++}.tmp`);
      await fs.writeFile(tmpPath, body);
      await fs.rename(tmpPath, finalPath); // atomic publish — a reader never sees a partial file
    });
  writeChains.set(dir, next);
  return next;
}

/** Stat a host path → { path, exists, bytes }. Never throws (missing ⇒ exists:false). */
export async function artifactState(absPath: string, displayPath: string): Promise<ArtifactState> {
  try {
    const st = await fs.stat(absPath);
    // exists = the path is present on disk (a 0-byte file like .gitkeep is legitimately present).
    return { path: displayPath, exists: true, bytes: st.isFile() ? st.size : 0 };
  } catch {
    return { path: displayPath, exists: false, bytes: 0 };
  }
}

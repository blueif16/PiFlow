// The run-status record — a future-viz-friendly mirror of the engine's `run-status.json` (run.mjs
// schema + writeStatus 639–668), kept faithful enough that a viz/dashboard can read it unchanged.
//
// The status is the SINGLE source of truth a watcher polls: a node is `ok` only when its declared
// artifacts exist ON DISK (the driver stat()s them — "verified, not trusted"). The writer is
// debounced-free and atomic-enough for the in-process tests (a plain pretty-printed write).

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Per-node status enum (run.mjs ladder): the terminal verdict the driver assigns each node. */
export type NodeStatus =
  | 'pending'   // not yet run (selected window)
  | 'running'   // exec in flight
  | 'ok'        // clean exit + every declared artifact present
  | 'gap'       // self-reported non-fatal gap (honored from the node's return)
  | 'blocked'   // a required artifact is missing (contract breach) — beats any self-report
  | 'error'     // killed (timeout/stall) or nonzero exit / degenerate run
  | 'reused'    // skipped upstream node whose artifacts were reused (--from resume)
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
  source?: string;
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

/** Write the run status to `<dir>/run-status.json` (pretty-printed; mkdir -p first). */
export async function writeStatus(dir: string, status: RunStatus): Promise<void> {
  status.updatedAt = nowISO();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'run-status.json'), JSON.stringify(status, null, 2));
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

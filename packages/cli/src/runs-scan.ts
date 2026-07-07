// The SHARED runs-home scan — the ONE reader both the `optimize triage --topk` selector (optimize-substrate.ts)
// and the top-level `runs` verb (runs.ts) ride, so their notion of "a run under this workflow where node X
// executed fresh" can never diverge (the M5 plan's explicit "extract the shared scan into one helper" law).
//
// It reads each `<runsHome>/<id>/.pi/run.json` (via the injected loader; default `@piflow/core`'s `readRunJson`),
// tolerating an absent/torn/half-written run.json — that run dir is simply dropped from the scan, never a throw.
// Returned NEWEST-FIRST by `startedAt`, so `--topk K` = `slice(0, K)` and the `runs` verb renders recent-first.

import path from 'node:path';
import { readdirSync } from 'node:fs';
import { readRunJson } from '@piflow/core';
import type { RunStatus } from '@piflow/core';

/** One scanned run: its canonical id (the run-dir basename), the absolute dir, and its parsed `.pi/run.json`. */
export interface RunSummary {
  id: string;
  runDir: string;
  status: RunStatus;
}

/** The injectable fs/core seam — defaults are the real `readdirSync` + core `readRunJson`; a test passes fakes. */
export interface ScanRunsHomeDeps {
  /** list the run-id subdirs of a runs home (default the real fs; [] on a missing/unreadable dir). */
  listRunIds?: (runsHome: string) => string[];
  /** read one run dir's `.pi/run.json` → RunStatus | null (default core `readRunJson`). */
  loadRunJson?: (runDir: string) => Promise<RunStatus | null>;
}

/** The run-id subdirs of a runs home, or [] on a missing/unreadable dir (never throws — a fresh workflow). */
export function listRunIds(runsHome: string): string[] {
  try {
    return readdirSync(runsHome, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Scan every run under `runsHome`, returning the ones with a READABLE `.pi/run.json`, sorted NEWEST-FIRST by
 * `startedAt` (a run whose status is absent/unparseable is dropped, never crashes the scan). This is the single
 * source both the `--topk` selector and the `runs` verb consume — one scan, one ordering, no divergence.
 */
export async function scanRunsHome(runsHome: string, deps: ScanRunsHomeDeps = {}): Promise<RunSummary[]> {
  const list = deps.listRunIds ?? listRunIds;
  const load = deps.loadRunJson ?? readRunJson;
  const out: RunSummary[] = [];
  for (const id of list(runsHome)) {
    const runDir = path.join(runsHome, id);
    let status: RunStatus | null;
    try {
      status = await load(runDir);
    } catch {
      status = null; // a torn/half-written run.json degrades to "skip this run", never sinks the scan.
    }
    if (status) out.push({ id, runDir, status });
  }
  return out.sort((a, b) =>
    a.status.startedAt < b.status.startedAt ? 1 : a.status.startedAt > b.status.startedAt ? -1 : 0,
  );
}

/**
 * Did `node` execute FRESH in this run — i.e. run.json records it with an EXECUTED terminal status (`ok` or
 * `error`), NOT `reused` (a `--from` skip whose artifacts were carried in), nor still pending/running? This is
 * the exact selector the M5 plan pins ("nodes[id].status ok/error, not reused") and the ONE both the `--topk`
 * triage-candidate scan and the `runs` verb's `--node` filter share.
 */
export function nodeRanFresh(status: RunStatus, node: string): boolean {
  const s = status.nodes?.[node]?.status;
  return s === 'ok' || s === 'error';
}

/** The run's OVERALL outcome derived from run.json — the `runs` verb's `--status` filter axis. A finished run is
 *  `ok` (`ok===true`) or `error` (anything else terminal); an unfinished run is `running`. */
export function runLevelStatus(status: RunStatus): 'ok' | 'error' | 'running' {
  if (!status.done) return 'running';
  return status.ok === true ? 'ok' : 'error';
}

/** `parseNodeRef`'s result: the bare node id, plus — for a DOTTED ref — the run it pins. */
export interface NodeRef {
  node: string;
  run?: string;
}

/**
 * Parse a `--node` value that may be a DOTTED `<run>.<node>` reference — `--node tS2.gameplay` ≡ `--node
 * gameplay --run tS2` — into `{ node, run? }`. No dot → `{ node: value }` (behavior byte-unchanged; the
 * overwhelming common case never touches the filesystem).
 *
 * A dotted value is ambiguous on its face: the child-run mint rule (`childRunName`, names/child.ts) names a
 * spawned child run `<parentId>.<nodeId>[.<n>]`, so `tS2.gameplay` could ITSELF be an existing child run's own
 * id (its node is segment 1) — or `tS2` could be a plain base run with `gameplay` just the node inside it (also
 * segment 1). Either reading yields the same `node` (segment 1); only which run gets pinned differs, so: the
 * FULL string is checked FIRST (a genuine child-run id is the more specific match and wins), else segment 0
 * must itself name a run, else a clear error naming both attempts (the value names no run at all).
 */
export function parseNodeRef(value: string, runsHome: string): NodeRef {
  if (!value.includes('.')) return { node: value };
  const segments = value.split('.');
  const node = segments[1];
  const runIds = new Set(listRunIds(runsHome));
  if (runIds.has(value)) return { run: value, node };
  if (runIds.has(segments[0])) return { run: segments[0], node };
  throw new Error(
    `piflowctl: dotted --node "${value}" names no run under ${runsHome} — looked for a run "${value}" and a run "${segments[0]}".`,
  );
}

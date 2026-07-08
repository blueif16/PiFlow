// `piflowctl runs sweep [--dry-run|--apply] [--include-frozen] [--json]` — a REGISTRY-WIDE audit (every
// registered product's `.piflow/<wf>/runs/*`, NOT the single-workflow scope of `piflowctl runs`/`runs.ts`)
// that classifies every discovered `!done` run and, on `--apply`, force-CLOSES the ones the already-merged
// live orphan-detection (`observe/read.ts`'s `isRunOrphaned`) can never resolve on its own:
//   - a run with NO `controllerPid` recorded at all (predates the field, or died before its first status
//     write) — `isRunOrphaned` deliberately returns false rather than guess; this is the primary sweep target.
//   - a `frozen:true` run (a deliberate P6 migration pause) whose controller may be dead but whose resume
//     never came — live detection EXCLUDES these on purpose (frozen ≠ abandoned), so only a human opting in
//     via `--include-frozen` can close them.
//
// Every `!done` run is classified into EXACTLY one bucket:
//   - auto-heals    has a controllerPid and is NOT frozen — the live-detection fix already self-heals these
//                   on every read. Reported for visibility; NEVER written here, under any flag combination.
//   - stuck-no-pid  no controllerPid at all.
//   - frozen        frozen:true (checked FIRST — a frozen run with a controllerPid is still `frozen`, not
//                   `auto-heals`: it is deliberately parked, not merely orphaned).
// Default is DRY-RUN (report the plan, write nothing) — `--apply` is required to write, and even then only
// `stuck-no-pid` (+ `frozen` iff `--include-frozen`) are ever finalized; `auto-heals` rows are never written.
// Every write goes through the SAME core `finalizeRun` primitive `node --finalize` uses — never a duplicated
// writer.

import path from 'node:path';
import { loadRegistry as coreLoadRegistry, discoverRunDirs as coreDiscoverRunDirs, readRunJson as coreReadRunJson, finalizeRun as coreFinalizeRun, type Registry, type RunStatus, type FinalizeResult } from '@piflow/core';

export type SweepBucket = 'auto-heals' | 'stuck-no-pid' | 'frozen';
export type SweepAction = 'finalized' | 'would-finalize' | 'skipped';

/** One discovered `!done` run's classification + what the sweep did (or would do) about it. */
export interface SweepRow {
  id: string;
  /** the registered product (repo) this run lives under. */
  product: string;
  /** the workflow dir this run belongs to (`.piflow/<wf>/runs/<id>`). */
  workflow: string;
  runDir: string;
  bucket: SweepBucket;
  /** ms since the run last wrote `.pi/run.json` (now − updatedAt), or null when updatedAt is missing/unparseable. */
  ageMs: number | null;
  action: SweepAction;
}

export interface RunsSweepArgs {
  apply: boolean;
  includeFrozen: boolean;
  json: boolean;
}

/**
 * Parse `runs sweep`'s flags. `--dry-run` ALWAYS wins over `--apply` regardless of argv order (both flags
 * are collected independently, then combined) — `--apply` must never become the default under any
 * combination, and an explicit `--dry-run` is the strongest "definitely do not write" signal available.
 */
export function parseRunsSweepArgs(argv: string[]): RunsSweepArgs {
  let applyFlag = false;
  let dryRunFlag = false;
  let includeFrozen = false;
  let json = false;
  for (const k of argv) {
    if (k === '--apply') applyFlag = true;
    else if (k === '--dry-run') dryRunFlag = true;
    else if (k === '--include-frozen') includeFrozen = true;
    else if (k === '--json') json = true;
  }
  return { apply: applyFlag && !dryRunFlag, includeFrozen, json };
}

/**
 * Classify a `!done` RunStatus into exactly one bucket. `frozen` is checked FIRST: a frozen run that also
 * carries a controllerPid is still deliberately parked, not merely orphaned-and-self-healing.
 */
export function classifySweepRun(status: Pick<RunStatus, 'frozen' | 'controllerPid'>): SweepBucket {
  if (status.frozen) return 'frozen';
  const pid = status.controllerPid;
  const hasPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
  return hasPid ? 'auto-heals' : 'stuck-no-pid';
}

/** The workflow dir a run belongs to, derived from its own canonical path (`.piflow/<wf>/runs/<id>`) — the
 *  same §D9 shape `discoverRunDirs` only ever emits, so this never needs to parse `run.json.source`. */
function workflowOfRunDir(root: string, runDir: string): string {
  const rel = path.relative(root, runDir).split(path.sep);
  return rel[1] ?? path.basename(path.dirname(path.dirname(runDir)));
}

/** The injectable seam — defaults are the real core registry/discovery/read/write; a test passes fakes. */
export interface RunsSweepDeps {
  print?: (s: string) => void;
  loadRegistry?: () => Registry;
  discoverRunDirs?: (root: string) => { runDirs: string[] };
  loadRunJson?: (runDir: string) => Promise<RunStatus | null>;
  finalize?: (runDir: string, opts?: { ok?: boolean }) => Promise<FinalizeResult>;
  now?: () => number;
}

/**
 * `piflowctl runs sweep [--dry-run|--apply] [--include-frozen] [--json]`. Returns the process exit code
 * (always 0 — a classification/report run never fails just because it found stuck runs; an unreadable
 * per-run status is silently dropped from the report like every other observe-layer scan).
 */
export async function runRunsSweepCli(argv: string[], deps: RunsSweepDeps = {}): Promise<number> {
  const args = parseRunsSweepArgs(argv);
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const loadRegistry = deps.loadRegistry ?? coreLoadRegistry;
  const discoverRunDirs = deps.discoverRunDirs ?? coreDiscoverRunDirs;
  const loadRunJson = deps.loadRunJson ?? coreReadRunJson;
  const finalize = deps.finalize ?? coreFinalizeRun;
  const now = deps.now ?? (() => Date.now());

  const registry = loadRegistry();
  const rows: SweepRow[] = [];

  for (const product of registry.products) {
    const { runDirs } = discoverRunDirs(product.root);
    for (const runDir of runDirs) {
      const status = await loadRunJson(runDir);
      if (!status || status.done) continue; // sweep concerns ONLY !done runs (a done run has its verdict)

      const bucket = classifySweepRun(status);
      const eligible = bucket === 'stuck-no-pid' || (bucket === 'frozen' && args.includeFrozen);
      const updatedMs = status.updatedAt ? Date.parse(status.updatedAt) : NaN;
      const ageMs = Number.isFinite(updatedMs) ? Math.max(0, now() - updatedMs) : null;

      let action: SweepAction = 'skipped';
      if (eligible) {
        if (args.apply) {
          const result = await finalize(runDir, { ok: false });
          action = result.wrote ? 'finalized' : 'skipped';
        } else {
          action = 'would-finalize';
        }
      }

      rows.push({
        id: path.basename(runDir),
        product: product.id,
        workflow: workflowOfRunDir(product.root, runDir),
        runDir,
        bucket,
        ageMs,
        action,
      });
    }
  }

  if (args.json) {
    print(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (!rows.length) {
    print('piflowctl runs sweep: no !done runs found across the registered products.');
    return 0;
  }
  for (const r of rows) {
    const age = r.ageMs != null ? `${Math.round(r.ageMs / 1000)}s` : '—';
    print(`${r.product}/${r.workflow}/${r.id}  [${r.bucket}]  age=${age}  → ${r.action}`);
  }
  const acted = rows.filter((r) => r.action === 'finalized' || r.action === 'would-finalize').length;
  print(
    args.apply
      ? `piflowctl runs sweep: ${acted} run(s) finalized${args.includeFrozen ? ' (including frozen)' : ''}.`
      : `piflowctl runs sweep: DRY-RUN (writes nothing) — ${acted} run(s) would be finalized${args.includeFrozen ? ' (including frozen)' : ''}. Pass --apply to write.`,
  );
  return 0;
}

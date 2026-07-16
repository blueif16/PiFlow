// optimize/blame/measure.ts — WS-B1 of docs/design/optimize-blame.md §2/§4 step 1: the RUN-LEVEL hard
// measurement fold, the run-level TWIN of optimize/substrate/measure.ts's `runSubstrateMeasure` — same
// grammar, same degrade discipline, one level up (§2: "the template's runway uses the EXACT
// `optimize.{measure,criteria}` structure a node uses"). Mirrors that module's patterns EXACTLY:
//
//   1. Read `optimize.measure` op[] straight off `<templateDir>/meta.json` (fs, never the compiled
//      WorkflowSpec — WS-B0's meta-level block is optimizer-facing only, same law as node.schema.ts:385).
//      A missing/unreadable meta.json or an absent `optimize.measure` degrades to an EMPTY op[]
//      (config-with-defaults). This is the EXPECTED-SPARSE case (§2): most templates leave the run-level
//      hard slot empty — the run's mechanical floor already comes from every node's OWN hard report, so an
//      empty op[] must still fold to a VALID report, never an error (the seam matters, not a measure zoo).
//   2. Build a standalone `ResolveCtx` — `{run, workspace, state, args}` — `loadState` + the run's persisted
//      args (`readRunArgs`, the runner's `.pi/run.json` mirror). `resolveDeep` PER-OP, not the whole tree:
//      an existing/finished run may predate arg-persistence or carry an empty state.json, so a token that
//      can't resolve drops ONLY that op (recorded in `ops.rejected` with its reason) — every other op, and
//      the digest fold below, still runs. Verbatim of substrate/measure.ts:148-165's degrade-not-throw seam,
//      duplicated here (this substrate is equally out-of-band over a FINISHED run).
//   3. Fire the RUNNABLE `run` ops FIRST, then the POST gates — the same node-lifecycle ops-then-verdict
//      order substrate/measure.ts uses, so a gate MAY assert on a file a measure run-op just produced.
//   4. Fold GRADED numeric leaves from every op's own declared `writes[]` JSON (best-effort; keyed
//      `<opId>.<leaf>`) — identical `foldNumericLeaves` logic to the substrate module.
//   5. PLUS a run-level DIGEST section (the evidence pack §4 step 2 draws on): best-effort project
//      `projectRunDigest(buildRunView(runDir).view)` down to `{nodes:[{id,status,anomalies}], rootCauses}`.
//      A malformed/incomplete run dir (bad or absent `.pi/run.json`) degrades to `{nodes:[],rootCauses:[]}`
//      — never throws; the ops+graded sections still stand on their own.
//   6. Write ONE deterministic report to `blameMeasurePath(runDir)` and return it.
//
// Never throws on a missing/partial input (config-with-defaults + best-effort degrade throughout, same
// contract as substrate/measure.ts) — the only failures that propagate are a truly unwritable report dir or
// a rejected `fs.writeFile`.

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { OpSpec } from '../../types.js';
import type { ResolveCtx } from '../../workflow/resolver.js';
import { resolveDeep } from '../../workflow/resolver.js';
import { loadState } from '../../workflow/state.js';
import { gatesFromOp, runOpsFromOp } from '../../runner/op-dispatch.js';
import { evaluateChecks, distillResultFile, type FileBytes } from '../../checks.js';
import { applyMergeOp } from '../../workflow/ops/merge.js';
import { runJsonFile } from '../../runner/layout.js';
import { buildRunView } from '../../observe/runView.js';
import { projectRunDigest, type AnomalyKind, type RootCause, type TelemetryThresholds } from '../../observe/telemetry.js';
import type { MeasureOpsSection, OpRunResult } from '../substrate/measure.js';
import { blameMeasurePath } from './paths.js';

/** Options for `runBlameMeasure`. */
export interface RunBlameMeasureOpts {
  /** `{{WORKSPACE}}` for the measure ops — ALWAYS the live product root (mirrors RunSubstrateMeasureOpts). */
  workspace: string;
  /** Overrides for the run-digest anomaly thresholds (config-with-defaults; passed through to `projectRunDigest`). */
  thresholds?: Partial<TelemetryThresholds>;
}

/** One digest node, reduced to what the blame judge's evidence pack needs (§4 step 2): identity, derived
 *  outcome, and the anomaly kinds that node tripped. `status` mirrors `NodeDigest.outcome`; absent only when
 *  the digest itself is empty (degrade path). */
export interface BlameDigestNode {
  id: string;
  status?: string;
  anomalies: AnomalyKind[];
}

/** The run-level digest section folded from `projectRunDigest` — best-effort, `{nodes:[],rootCauses:[]}` on
 *  any degrade (an incomplete/malformed run dir has no digest yet). */
export interface BlameDigestSection {
  nodes: BlameDigestNode[];
  rootCauses: RootCause[];
}

/** The one deterministic report `runBlameMeasure` writes (modulo `generatedAt`) — the run-level twin of
 *  `MeasureReport`. No `node`/`detectors` fields: this is the FINAL-artifact fold, not a per-node one. */
export interface BlameMeasureReport {
  generatedAt: string;
  ops: MeasureOpsSection;
  /** numeric metrics graded from any measure op's own declared `writes[]` JSON report leaves. */
  graded: Record<string, number>;
  digest: BlameDigestSection;
}

/** Where the product template lives relative to a canonical run dir (mirrors substrate/measure.ts's
 *  `templateDirForRun`, `.piflow/<wf>/runs/<id>` → `…/template` — duplicated, NOT imported, since
 *  `@piflow/core` never depends on `@piflow/cli`). */
function templateDirForRun(runDir: string): string {
  return path.resolve(runDir, '..', '..', 'template');
}

/** Best-effort read of the finished run's PERSISTED args off `<runDir>/.pi/run.json` (mirrors
 *  substrate/measure.ts's `readRunArgs`, duplicated for the same out-of-band-module self-containment). A
 *  missing/unparseable run.json or an absent/malformed `args` block degrades to `{}` — NEVER throws. */
async function readRunArgs(runDir: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as { args?: unknown };
    return raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args)
      ? (raw.args as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

/** Best-effort read of the template's RUN-LEVEL `optimize.measure` op[] straight off `<templateDir>/meta.json`
 *  (WS-B0's meta-level twin of `node.schema.ts:385`). Missing/unreadable/absent-block all degrade to `[]`
 *  (config-with-defaults — expected-sparse per §2, most templates author none). */
async function readMeasureOps(templateDir: string): Promise<OpSpec[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(templateDir, 'meta.json'), 'utf8')) as {
      optimize?: { measure?: OpSpec[] };
    };
    return Array.isArray(raw.optimize?.measure) ? raw.optimize!.measure! : [];
  } catch {
    return [];
  }
}

/** Merge every NUMERIC (finite) top-level leaf of `obj` into `into`, keyed `<prefix>.<leaf>` (mirrors
 *  substrate/measure.ts's `foldNumericLeaves` verbatim). Nested objects are NOT recursed; non-numeric/
 *  non-finite leaves are skipped, never coerced. */
function foldNumericLeaves(obj: unknown, prefix: string, into: Record<string, number>): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) into[`${prefix}.${k}`] = v;
  }
}

/**
 * Run the RUN-LEVEL hard measurement stage for one finished run: fire the template's `optimize.measure` op[]
 * (read off `<templateDir>/meta.json`), fold the run digest, and write ONE deterministic report to
 * `blameMeasurePath(runDir)`. Never throws on a missing/partial input — the only failures that propagate are
 * a truly unwritable report dir or a rejected `fs.writeFile`. An EMPTY op[] still produces a VALID report
 * (§2/§10 WS-B1 acceptance: "an empty op[] folds to a valid empty report" — the seam matters, not a measure zoo).
 */
export async function runBlameMeasure(runDir: string, opts: RunBlameMeasureOpts): Promise<BlameMeasureReport> {
  const templateDir = templateDirForRun(runDir);
  const rawOps = await readMeasureOps(templateDir);

  const state = await loadState(runDir);
  // Load the run's persisted args so a measure op's `{{arg.<key>}}` token resolves against the SAME args the
  // run ran under (best-effort; absent ⇒ `{}` — see readRunArgs).
  const args = await readRunArgs(runDir);
  const resolveCtx: ResolveCtx = { run: runDir, workspace: opts.workspace, state, args };
  // Resolve the op[] PER-OP, not the whole tree at once — see the module header for why: an op that can't
  // resolve is DROPPED from execution and RECORDED in `ops.rejected` with its reason (triage sees WHY it
  // could not run, never a silent pass and never a crash); every OTHER op + the digest fold still run.
  const resolvedOps: OpSpec[] = [];
  const resolveRejected: string[] = [];
  for (const rawOp of rawOps) {
    try {
      resolvedOps.push(resolveDeep(rawOp, resolveCtx));
    } catch (err) {
      const opRef = rawOp.id ? `measure op '${rawOp.id}'` : 'a measure op';
      resolveRejected.push(`${opRef} could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // A file reader rooted at the run dir — hoisted above the run loop so a failing resultFile op (below)
  // reuses the SAME reader the post gates use (jail-correct: the exact bytes a live run would see).
  const readBytes = (rel: string): FileBytes => {
    try {
      const abs = path.resolve(runDir, rel);
      return { bytes: readFileSync(abs, 'utf8'), size: statSync(abs).size };
    } catch {
      return { bytes: null, size: 0 };
    }
  };

  // (1) runnable `run` ops FIRST — same node-lifecycle.ts:588 / substrate/measure.ts pattern.
  const { runnable, rejected } = runOpsFromOp(resolvedOps);
  const runs: OpRunResult[] = [];
  for (const { body, resultFile } of runnable) {
    const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, runDir);
    // (op-integrity WS-I5) IDENTICAL to substrate/measure.ts: a FAILING op declaring a `resultFile` gets its
    // `detail` from the ledger's content — naming the failing CHECK — never left as raw stderr noise.
    const detail = r.failed && resultFile ? distillResultFile(resultFile, readBytes(resultFile).bytes) : undefined;
    runs.push({
      cmd: (r.cmd as string | undefined) ?? body.cmd,
      wrote: !!r.wrote,
      failed: !!r.failed,
      exit: r.exit,
      stderr: r.stderr,
      stdout: r.stdout,
      ...(detail ? { detail } : {}),
      ...(resultFile ? { resultFile } : {}),
    });
  }

  // (2) POST gates AFTER the run ops (so a gate may assert on a file a run-op just produced).
  const { post } = gatesFromOp(resolvedOps);
  const checks = evaluateChecks(post, readBytes);

  // (3) graded numeric metrics from any `run` op's OWN declared `writes[]` JSON report (best-effort).
  const graded: Record<string, number> = {};
  for (const o of resolvedOps) {
    if (!o.run || !o.writes?.length) continue;
    const key = o.id ?? path.basename(o.writes[0], path.extname(o.writes[0]));
    for (const w of o.writes) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.resolve(runDir, w), 'utf8'));
        foldNumericLeaves(parsed, key, graded);
      } catch {
        /* not every write is JSON, and a failed op leaves nothing to fold — best-effort, never throws */
      }
    }
  }

  // (4) the run-level digest fold (§4 step 2's evidence-pack input) — best-effort, degrades to empty.
  let digest: BlameDigestSection = { nodes: [], rootCauses: [] };
  try {
    const { view } = buildRunView(runDir);
    const projected = projectRunDigest(view, opts.thresholds ? { thresholds: opts.thresholds } : {});
    digest = {
      nodes: projected.nodes.map((n) => ({ id: n.id, status: n.outcome, anomalies: n.anomalies })),
      rootCauses: projected.rootCauses,
    };
  } catch {
    /* an incomplete/malformed run dir (no valid .pi/run.json) has no digest yet — the ops+graded sections
     * still stand */
  }

  const report: BlameMeasureReport = {
    generatedAt: new Date().toISOString(),
    ops: { checks, runs, rejected: [...resolveRejected, ...rejected.map((r) => r.detail)] },
    graded,
    digest,
  };

  const outPath = blameMeasurePath(runDir);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  return report;
}

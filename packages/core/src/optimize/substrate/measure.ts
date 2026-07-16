// optimize/substrate/measure.ts — M3.1/M3.2 of docs/specs/optimize-substrate-plan.md: the HARD measurement
// stage. Fully external to the runner — reuses the op READER (op-dispatch.ts) + the pure EXECUTORS
// (checks.ts/merge.ts) `node-lifecycle.ts` already uses; `node-lifecycle.ts` is UNTOUCHED by this module.
//
// Flow (mirrors node-lifecycle.ts's own ops→verify ordering, §M3.1/§M3.2):
//   1. Read the node's `optimize.measure` op[] DIRECTLY off `<templateDir>/nodes/<id>/node.json` (fs, never
//      the compiled NodeSpec — the block is optimizer-facing only, per M0). A missing/unreadable node.json
//      or an absent `optimize.measure` degrades to an EMPTY op[] (config-with-defaults) — detectors still run.
//   2. Build a standalone `ResolveCtx` — `{ run: runDir, workspace, state }` — and `resolveDeep` the WHOLE
//      op[] tree ONCE (so every `{{RUN}}`/`{{WORKSPACE}}`/`{{state.*}}` token, incl. ones nested inside a
//      `run.args[]` string, is physical before any executor sees it). ⚡ `{{WORKSPACE}}` here ALWAYS resolves
//      to the LIVE product root the caller passes — never a candidate copy — keeping the oracle immutable in
//      practice (M6.3 relies on this).
//   3. Fire the RUNNABLE `run` ops FIRST (`runOpsFromOp(ops).runnable → applyMergeOp({run}, runDir)` — the
//      exact node-lifecycle.ts:588 pattern), THEN the POST gates (`gatesFromOp(ops).post → evaluateChecks`) —
//      same order node-lifecycle.ts uses (ops execute, THEN the artifact/checks verdict), so a gate MAY assert
//      on a file a measure run-op just produced (the convention: measure ops write under
//      `{{RUN}}/optimize/substrate/`, so measuring never clobbers the run's own report artifacts).
//   4. Fold GRADED numeric metrics: for every measure op with BOTH a `run` body and a declared `writes[]`,
//      best-effort read each declared write as JSON and merge its top-level numeric leaves into `graded`
//      (keyed `<opId>.<leaf>`) — the mechanical, ambiguity-free way to surface "any numbers surfaced by op
//      report JSONs when parseable" (plan §M3.4) without guessing at an op's output path.
//   5. Run the built-in trace detectors (trace-metrics.ts) over `.pi/nodes/<id>/events.jsonl`, and fold
//      `projectRunDigest(buildRunView(runDir).view)`'s anomalies for this node (best-effort — a run dir
//      without a valid `.pi/run.json` degrades to no digest, never throws).
//   6. Write ONE deterministic report to `<runDir>/optimize/substrate/measure.<node>.json` and return it.

import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { OpSpec } from '../../types.js';
import type { ResolveCtx } from '../../workflow/resolver.js';
import { resolveDeep } from '../../workflow/resolver.js';
import { loadState } from '../../workflow/state.js';
import { gatesFromOp, runOpsFromOp } from '../../runner/op-dispatch.js';
import { evaluateChecks, distillResultFile, type CheckResult, type FileBytes } from '../../checks.js';
import { applyMergeOp } from '../../workflow/ops/merge.js';
import { nodeEventsFile, runJsonFile } from '../../runner/layout.js';
import { buildRunView } from '../../observe/runView.js';
import { projectRunDigest, type AnomalyKind } from '../../observe/telemetry.js';
import { analyzeTraceFile, type SubstrateThresholds, type TraceMetricsReport } from './trace-metrics.js';

/** Options for `runSubstrateMeasure`. */
export interface RunSubstrateMeasureOpts {
  /** `{{WORKSPACE}}` for the measure ops — ALWAYS the live product root (never a candidate copy; see M6.3). */
  workspace: string;
  /** Overrides for the trace-detector thresholds (config-with-defaults; see trace-metrics.ts). */
  thresholds?: Partial<SubstrateThresholds>;
}

/** One executed `run` measure-op's outcome (the fields a consumer needs; mirrors merge.ts's MergeResult). */
export interface OpRunResult {
  cmd: string;
  wrote: boolean;
  failed: boolean;
  exit?: number;
  stderr?: string;
  stdout?: string;
  /**
   * (op-integrity WS-I5) When the op declares a `resultFile` (its structured verdict — by convention the
   * gate ledger) and FAILED, this is the DISTILLED verdict (`distillResultFile`) — the gate's real reason
   * (naming the failing CHECK), never the first stderr line. Mirrors the LIVE run's opFailures.detail
   * (node-lifecycle.ts/node-lanes.ts, WS-I2) so a triage/blame judge reading THIS out-of-band report sees the
   * SAME verdict a live run would have surfaced. Absent when the op declares no `resultFile`, or passed.
   */
  detail?: string;
  /** The raw resultFile path, so a verb/judge can open the structured verdict directly. */
  resultFile?: string;
}

/** The op[]-execution half of the report. */
export interface MeasureOpsSection {
  checks: CheckResult[];
  runs: OpRunResult[];
  /** detail strings for measure ops that could NOT run — a `run` op the runner has no executor for, OR an op
   *  whose `{{arg.*}}`/`{{state.*}}` tokens don't resolve over this finished run (dropped + recorded, never a
   *  silent pass and never a crash). */
  rejected: string[];
}

/** The one deterministic report `runSubstrateMeasure` writes (modulo `generatedAt`). */
export interface MeasureReport {
  node: string;
  generatedAt: string;
  ops: MeasureOpsSection;
  detectors: TraceMetricsReport;
  /** this node's anomaly kinds from `projectRunDigest` (empty when the run has no digest, e.g. incomplete). */
  digestAnomalies: AnomalyKind[];
  /** numeric metrics graded from detector spans/ratios + any parseable op-report JSON leaves. */
  graded: Record<string, number>;
}

/** Where the product template lives relative to a canonical run dir (mirrors packages/cli/optimize-fix.ts's
 *  `templateDirFor`, `.piflow/<wf>/runs/<id>` → `…/template` — duplicated here, NOT imported, since
 *  `@piflow/core` never depends on `@piflow/cli`). */
function templateDirForRun(runDir: string): string {
  return path.resolve(runDir, '..', '..', 'template');
}

/** Best-effort read of the finished run's PERSISTED args off `<runDir>/.pi/run.json` (the runner mirrors the
 *  run's `--arg k=v` there). So a measure op referencing `{{arg.<key>}}` resolves against the SAME args the run
 *  ran under. A missing/unparseable run.json or an absent/malformed `args` block degrades to `{}` — NEVER throws
 *  (the whole module's contract). The resolver keeps its loud discipline downstream: an absent KEY still throws
 *  `MissingArgError` (never a silent ''), so an EMPTY args object does NOT weaken that guarantee. */
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

/** Best-effort read of a node's `optimize.measure` op[] straight off `<templateDir>/nodes/<id>/node.json`.
 *  Missing/unreadable/absent-block all degrade to `[]` (config-with-defaults — detectors still run). */
async function readMeasureOps(templateDir: string, nodeId: string): Promise<OpSpec[]> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(templateDir, 'nodes', nodeId, 'node.json'), 'utf8')) as {
      optimize?: { measure?: OpSpec[] };
    };
    return Array.isArray(raw.optimize?.measure) ? raw.optimize!.measure! : [];
  } catch {
    return [];
  }
}

/** Merge every NUMERIC (finite) top-level leaf of `obj` into `into`, keyed `<prefix>.<leaf>`. Nested objects
 *  are NOT recursed (a report's top-level numeric fields are the graded surface; deep nesting is the op's
 *  own business) — non-numeric/non-finite leaves are skipped, never coerced. */
function foldNumericLeaves(obj: unknown, prefix: string, into: Record<string, number>): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) into[`${prefix}.${k}`] = v;
  }
}

/**
 * Run the hard measurement stage for one (run, node): fire the node's `optimize.measure` op[], the built-in
 * trace detectors, and the run digest — fold all three into ONE deterministic report, write it to
 * `<runDir>/optimize/substrate/measure.<node>.json`, and return it. Never throws on a missing/partial input
 * (config-with-defaults + best-effort degrade throughout) — the only failures that propagate are a truly
 * unwritable report dir or a rejected `fs.writeFile`.
 */
export async function runSubstrateMeasure(
  runDir: string,
  nodeId: string,
  opts: RunSubstrateMeasureOpts,
): Promise<MeasureReport> {
  const templateDir = templateDirForRun(runDir);
  const rawOps = await readMeasureOps(templateDir, nodeId);

  const state = await loadState(runDir);
  // Load the run's persisted args so a measure op's `{{arg.<key>}}` token resolves against the SAME args the
  // run ran under (best-effort; absent ⇒ `{}` — see readRunArgs).
  const args = await readRunArgs(runDir);
  const resolveCtx: ResolveCtx = { run: runDir, workspace: opts.workspace, state, args };
  // Resolve the op[] PER-OP, not the whole tree at once. `resolveDeep` keeps its LOUD discipline (a missing
  // `{{arg.*}}`/`{{state.*}}` throws `MissingArgError`/`MissingChannelError`) — CORRECT on the RUN path, where
  // a real misconfiguration must fail loud. But this substrate is OUT-OF-BAND over a FINISHED run: existing
  // runs predate arg-persistence (`args:{}`) and some have an empty state.json, so an op referencing such a
  // token would otherwise crash the WHOLE node's measurement — the other ops, the detectors, and the digest
  // with it — violating this module's degrade-not-throw contract. So an op that can't resolve is DROPPED from
  // execution and RECORDED in `ops.rejected` with its reason (triage sees WHY it could not run, never a silent
  // pass and never a crash); every OTHER op + the detectors + the digest still run.
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

  // (1) runnable `run` ops FIRST — same node-lifecycle.ts:588 pattern (`{run}` wrapped for applyMergeOp).
  const { runnable, rejected } = runOpsFromOp(resolvedOps);
  const runs: OpRunResult[] = [];
  for (const { body, resultFile } of runnable) {
    const r = await applyMergeOp({ run: { cmd: body.cmd, args: body.args, cwd: body.cwd } }, runDir);
    // (op-integrity WS-I5) A FAILING op that declares a `resultFile` (its structured verdict, by convention
    // the gate ledger) gets its `detail` built from THAT file's content — the gate's real reason, naming the
    // failing CHECK — instead of leaving only `stderr` (the raw noise a triage/blame judge used to read
    // verbatim; the design doc's motivating incident). Mirrors node-lifecycle.ts's opFailures.detail exactly.
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

  // (4) the built-in trace detectors over this node's event archive (absent file degrades to an empty report).
  const detectors = analyzeTraceFile(nodeEventsFile(runDir, nodeId), opts.thresholds);

  // (5) fold this node's digest anomalies (best-effort — a run without a valid `.pi/run.json` yields none).
  let digestAnomalies: AnomalyKind[] = [];
  try {
    const { view } = buildRunView(runDir);
    const digest = projectRunDigest(view);
    digestAnomalies = digest.nodes.find((n) => n.id === nodeId)?.anomalies ?? [];
  } catch {
    /* an incomplete/malformed run dir has no digest yet — the ops+detectors sections still stand */
  }

  const report: MeasureReport = {
    node: nodeId,
    generatedAt: new Date().toISOString(),
    ops: { checks, runs, rejected: [...resolveRejected, ...rejected.map((r) => r.detail)] },
    detectors,
    digestAnomalies,
    graded,
  };

  const outPath = path.join(runDir, 'optimize', 'substrate', `measure.${nodeId}.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(report, null, 2));
  return report;
}

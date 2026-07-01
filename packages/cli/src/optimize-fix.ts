// `piflowctl optimize --fix --binding <module> [--node <substr>] [--staging-dir <d>] [--auto-adopt] [--edit-budget n] [--token-budget n] [--fix-cycle-ceiling n]`
// — the FIX→GATE→LAND driver surfaced on the CLI (piflow-memory-v1.5 §6). It INVENTS the product→optimizer
// injection convention (none existed): a PRODUCT binding module supplies the LIVE stages that cannot live in
// @piflow/core — `oracle` (the product's runMilestoneVerify2 + build), `copyScope`, `fixer` — and the CLI
// dynamic-imports it (mirroring run.ts's `@piflow/daytona` sandbox pattern), then COMPOSES the already-tested,
// product-agnostic core pieces: scoreRun → triage → mineTaskFromTrace → makeReplayStages → runFixGate →
// writeStagingManifest. It LANDS NOTHING live — it stages a manifest; physical adopt is a separate step.
//
// `scoreRun` is injectable (OptimizeFixDeps) so the composition is testable without a live trace; the live
// binding (the browser+build oracle) is validated by a real run, not CI.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoreRun as coreScoreRun, triage, deriveRecurrence, memorize, mineTaskFromTrace, makeReplayStages, runFixGate, writeStagingManifest, renderOptimizeEvent } from '@piflow/core';
import type { ReplayOracle, CopyScope, Fixer, MineOpts, NodeScore, RunDigest, OptimizeEventSink, Defect, FixGateResult } from '@piflow/core';
import { resolveTopicsDir, resolveSlice } from './understand.js';

/** The product binding the CLI dynamic-imports — the LIVE stages that stay product-side (out of @piflow/core). */
export interface OptimizeBinding {
  /** re-verify a candidate build → a raw verify report (game-omni: runMilestoneVerify2 + npm build). */
  oracle: ReplayOracle;
  /** copy the node's editable scope to a candidate dir (game-omni: copy the minimal set + rebuild). */
  copyScope: CopyScope;
  /** the context-isolated fixer that edits the candidate copy per defect bucket. */
  fixer: Fixer;
  /** OPTIONAL: run the product's workflow for a round and return its finished run dir — the `run` stage of the
   * multi-round `--rounds N` loop. Product-side (boundary law: @piflow/core cannot know how to run the workflow).
   * REQUIRED only for `--rounds > 1`; the single-shot `--fix` path (an already-finished run) never calls it. */
  run?: (round: number) => Promise<string>;
  /** optional: customize the default trace miner (node→milestone map, val/train split). */
  mineOpts?: MineOpts;
  /** OPTIONAL per-node fix-cycle counter (backs `--fix-cycle-ceiling`): reads how many failed cycles a node
   * has consumed across invocations. Persisted PRODUCT-side (boundary law); a binding WITHOUT it still validates. */
  readFixCycles?: (node: string) => number;
  /** OPTIONAL per-node fix-cycle counter writer — the driver bumps it after a real failed fix. Product-side. */
  bumpFixCycles?: (node: string) => void;
}

export interface ParsedOptimizeFixArgs {
  dir: string;
  binding: string;
  stagingDir?: string;
  autoAdopt: boolean;
  editBudget?: number;
  tokenBudget?: number;
  /** per-node fix-cycle CEILING — skip (escalate) a node that has consumed this many failed cycles across
   * invocations. Active only when the binding also exports readFixCycles/bumpFixCycles. */
  fixCycleCeiling?: number;
  /** substring filter on the worklist — process ONLY defects whose node id contains it (cost/safety scope). */
  node?: string;
  /** stream the live FIX→GATE progress (one OptimizeEvent line per phase) as the loop runs. */
  watch: boolean;
  /** with --watch, emit each event as a JSON line instead of the human-readable render (machine-consumable). */
  watchJson: boolean;
}

export interface OptimizeFixDeps {
  /** inject the score pass (the trace read); default = @piflow/core scoreRun. */
  scoreRun?: (dir: string) => Promise<{ scores: NodeScore[]; digest: RunDigest }>;
  print?: (s: string) => void;
}

export function parseOptimizeFixArgs(argv: string[]): ParsedOptimizeFixArgs {
  const out: ParsedOptimizeFixArgs = { dir: '', binding: '', autoAdopt: false, watch: false, watchJson: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--fix') continue; // the subcommand marker (the dispatcher already routed on it)
    else if (k === '--binding') out.binding = argv[++i] ?? '';
    else if (k === '--staging-dir') out.stagingDir = argv[++i];
    else if (k === '--auto-adopt') out.autoAdopt = true;
    else if (k === '--edit-budget') out.editBudget = Number(argv[++i]);
    else if (k === '--token-budget') out.tokenBudget = Number(argv[++i]);
    else if (k === '--fix-cycle-ceiling') out.fixCycleCeiling = Number(argv[++i]);
    else if (k === '--node') out.node = argv[++i];
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; } // --watch-json implies --watch
    else if (k.startsWith('--')) { /* ignore unknown flags */ }
    else positionals.push(k);
  }
  out.dir = positionals[0] ?? '';
  return out;
}

/** Dynamic-import a binding module (a local path or a package specifier) and validate its required stages. */
export async function loadBinding(spec: string): Promise<OptimizeBinding> {
  const looksLikePath = spec.startsWith('.') || spec.startsWith('/') || /\.(mjs|cjs|js)$/.test(spec);
  let mod: Record<string, unknown>;
  try {
    mod = looksLikePath ? await import(pathToFileURL(path.resolve(spec)).href) : await import(spec);
  } catch (e) {
    throw new Error(`optimize --binding: could not load binding '${spec}': ${(e as Error).message}`);
  }
  const b = ((mod.default as Record<string, unknown> | undefined) ?? mod) as Partial<OptimizeBinding>;
  for (const k of ['oracle', 'copyScope', 'fixer'] as const)
    if (typeof b[k] !== 'function')
      throw new Error(`optimize --binding: '${spec}' must export { oracle, copyScope, fixer } as functions (missing or invalid: ${k})`);
  return b as OptimizeBinding;
}

/**
 * Dereference each SKILL defect's `[[okf-slice]]` pointer to the linked slice's code-map body and inline it
 * into `scope.codeMap` — the Leg-A → Leg-B cross-reference, resolved AT FIX TIME (piflow-memory-v1.5 §6/§8;
 * pointer + resolve, never a stored copy). `resolve` returns the slice's curated body or `null`; a dangling
 * pointer leaves `codeMap` unset so the lesson's root/prevention still reach the fixer. Mutates in place;
 * defects without a pointer are untouched (the resolver is never called for them). Pure but for `resolve`.
 */
export function enrichCodeMap(defects: Defect[], resolve: (key: string) => string | null): void {
  for (const d of defects) {
    const key = d.scope?.okfSlice;
    if (!key) continue;
    const body = resolve(key);
    if (body) d.scope!.codeMap = [{ slice: key, body }];
  }
}

/** Where the product template lives relative to a canonical run dir (`.piflow/<wf>/runs/<id>` → …/template). */
export function templateDirFor(runDir: string): string {
  return path.resolve(runDir, '..', '..', 'template');
}

/**
 * SCORE → TRIAGE → enrich: the ONE worklist composition both the single-shot `--fix` and the multi-round loop
 * share (never duplicated divergently). Reads the run, folds the two tiers, projects the four-way worklist with
 * the Leg-A recurrence (the SKILL signal), then dereferences each SKILL lesson's `[[okf-slice]]` pointer into
 * `scope.codeMap` (resolve-at-read). `scoreRun` is injectable so it is testable without a live trace; `node`
 * scopes the worklist to one node (the cost/safety filter). Returns the enriched defects + the score pass so a
 * caller (memorize) can re-use them without re-scoring. Degrades silently on missing memory/slices — never throws.
 */
export async function scoreTriageEnrich(
  runDir: string,
  opts: { scoreRun?: OptimizeFixDeps['scoreRun']; node?: string } = {},
): Promise<{ scores: NodeScore[]; digest: RunDigest; defects: Defect[]; templateDir: string }> {
  const { scores, digest } = await (opts.scoreRun ?? coreScoreRun)(runDir);
  // Leg-A recurrence (the SKILL signal): resolve the product template from the run dir; deriveRecurrence
  // degrades to an empty index (⇒ pure LAPSE) if the path/memory is absent, so it can never crash the fix run.
  const templateDir = templateDirFor(runDir);
  const recurrence = deriveRecurrence({ templateDir, nodes: scores.map((s) => s.node) });
  // `--node <substr>` scopes the worklist to one node — the live oracle is expensive (build + browser per
  // candidate) and a degenerate incumbent (e.g. a bound-exhausted stub scoring 0) can make any edit look like
  // an improvement, so a targeted first run is both the cost bound and the safety scope.
  const defects = triage(scores, digest, { recurrence }).filter((d) => (opts.node ? d.node.includes(opts.node) : true));

  // Leg-A ↔ Leg-B cross-reference (piflow-memory-v1.5 §6/§8): dereference each SKILL lesson's `[[okf-slice]]`
  // link to the slice's curated code-map and inline it into the fixer's scope-context — resolve-at-read, never
  // a stored copy (so it reads the CURRENT drift-gated slice). Degrades silently if the repo has no `.agents/
  // okf/` or the linked slice is absent; the pointer + root/prevention still reach the fixer.
  const topicsDir = resolveTopicsDir(runDir);
  if (topicsDir) enrichCodeMap(defects, (key) => resolveSlice(topicsDir, key));

  return { scores, digest, defects, templateDir };
}

/** The FIX→GATE bounds/policy shared by the single-shot and the multi-round paths (autoAdopt + the budgets). */
export interface FixGatePolicy {
  autoAdopt: boolean;
  editBudget?: number;
  tokenBudget?: number;
  fixCycleCeiling?: number;
}

/**
 * Compose the binding's LIVE stages (oracle/copyScope/fixer + the optional fix-cycle counter) with the
 * product-agnostic core driver, bound to ONE run dir. Returns the `fixGate(defects, rejectedBuffer)` closure the
 * loop's `fixGate` stage IS — the single-shot path calls it once. The rejectedBuffer is THREADED so a dead edit
 * never re-recurs (across the loop's rounds). Identical wiring to what the single-shot path used inline (the fix-
 * cycle ceiling stays opt-in on BOTH sides; core no-ops it when the binding omits the counter stages).
 */
export function makeFixGateRunner(
  binding: OptimizeBinding,
  runDir: string,
  policy: FixGatePolicy,
  onEvent: OptimizeEventSink | undefined,
): (defects: Defect[], rejectedBuffer: Set<string>) => Promise<FixGateResult> {
  const mineTask = mineTaskFromTrace(runDir, binding.mineOpts);
  const stages = makeReplayStages({ oracle: binding.oracle, mineTask, copyScope: binding.copyScope });
  return (defects, rejectedBuffer) =>
    runFixGate(defects, {
      fixer: binding.fixer,
      ...stages,
      ...(binding.readFixCycles ? { readFixCycles: binding.readFixCycles } : {}),
      ...(binding.bumpFixCycles ? { bumpFixCycles: binding.bumpFixCycles } : {}),
    }, {
      autoAdopt: policy.autoAdopt,
      rejectedBuffer,
      ...(policy.editBudget !== undefined ? { editBudget: policy.editBudget } : {}),
      ...(policy.tokenBudget !== undefined ? { tokenBudget: policy.tokenBudget } : {}),
      ...(policy.fixCycleCeiling !== undefined ? { fixCycleCeiling: policy.fixCycleCeiling } : {}),
      ...(onEvent ? { onEvent } : {}),
    });
}

export async function runOptimizeFixCli(argv: string[], deps: OptimizeFixDeps = {}): Promise<void> {
  const args = parseOptimizeFixArgs(argv);
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  if (!args.dir) {
    process.stderr.write('piflowctl optimize --fix: a <rundir> is required (the finished run to fix).\n');
    process.exitCode = 2;
    return;
  }
  if (!args.binding) {
    process.stderr.write('piflowctl optimize --fix: --binding <module> is required (the product oracle/fixer; it is not in @piflow/core).\n');
    process.exitCode = 2;
    return;
  }

  // SCORE → TRIAGE → enrich (the shared worklist composition; scoreRun injectable for tests).
  const { scores, digest, defects, templateDir } = await scoreTriageEnrich(args.dir, {
    ...(deps.scoreRun ? { scoreRun: deps.scoreRun } : {}),
    ...(args.node ? { node: args.node } : {}),
  });

  // Compose the binding's LIVE stages with the product-agnostic core driver (the shared runner — same wiring the
  // multi-round loop uses). --watch: stream the live FIX→GATE progress through the driver's OWN OptimizeEventSink
  // (fire-and-forget; a throwing print never breaks the loop). --watch-json prints raw JSON.
  const binding = await loadBinding(args.binding);
  const onEvent: OptimizeEventSink | undefined = args.watch
    ? (e) => print(args.watchJson ? JSON.stringify(e) : renderOptimizeEvent(e))
    : undefined;
  const policy: FixGatePolicy = {
    autoAdopt: args.autoAdopt,
    ...(args.editBudget !== undefined ? { editBudget: args.editBudget } : {}),
    ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
    ...(args.fixCycleCeiling !== undefined ? { fixCycleCeiling: args.fixCycleCeiling } : {}),
  };
  const fixGate = makeFixGateRunner(binding, args.dir, policy, onEvent);
  const result = await fixGate(defects, new Set<string>());

  const stagingDir = args.stagingDir ?? path.join(args.dir, 'optimize', 'staging');
  const manifestPath = await writeStagingManifest(result, { stagingDir });
  const escalated = result.skipped.length ? `; ${result.skipped.length} node(s) escalated at the fix-cycle ceiling` : '';
  print(`optimize --fix: ${result.accepted}/${result.attempted} edit(s) accepted (${result.stoppedReason})${escalated}; manifest → ${manifestPath}`);
  process.stderr.write(`\noptimize --fix: staged ${result.accepted} accepted edit(s) across ${defects.length} defect(s) in ${digest.run || args.dir}; nothing landed live (adopt is a separate step).\n`);

  // MEMORIZE (Leg-A): persist the run's tier0-signature LAPSE/SKILL defects into `<template>/nodes/<node>/memory.md`
  // so the two-run recurrence carry needs no human hand-write — this closes the cross-INVOCATION loop (run `--fix`
  // on run-1, and a later run with the SAME signature triages SKILL, not LAPSE). Idempotent (the count is derived
  // from the run trail). Off the critical path; a failure here must never sink an already-staged fix.
  try {
    const { lessons } = memorize(scores, defects, { runDir: args.dir, templateDir });
    const appended = lessons.filter((l) => l.action === 'append').length;
    const updated = lessons.filter((l) => l.action === 'update').length;
    // to stderr (mirrors the read-only `optimize --memorize` path) so the primary stdout summary stays one line.
    process.stderr.write(`optimize --fix: memorized ${lessons.length} lesson(s) — ${appended} appended, ${updated} updated\n`);
  } catch (e) {
    process.stderr.write(`optimize --fix: MEMORIZE skipped (${(e as Error).message}); the staged fix is unaffected.\n`);
  }
}

// `piflowctl optimize --rounds N --binding <module> [--stalled-patience K] [--error-budget K] [--node <substr>]
//  [--auto-adopt] [--edit-budget n] [--token-budget n] [--fix-cycle-ceiling n] [--staging-dir <d>] [--watch]
//  [--watch-json]` — the MULTI-ROUND (autonomous-propose) OVERLORD surfaced on the CLI (piflow-memory-v1.5 §6).
//
// It COMPOSES the product-agnostic core driver `runOptimizeLoop` with the SAME injected stages the single-shot
// `--fix` path uses (scoreTriageEnrich + makeFixGateRunner + core memorize), plus the ONE stage that only the
// loop needs: `run(round)` — the PRODUCT runs its workflow for the round and returns its run dir. `run` is
// product-side by the boundary law (@piflow/core cannot know how to run a workflow), so it rides the binding.
// If `--rounds > 1` but the binding exports no `run`, this ERRORS and exits 2 — it does NOT fake a run.
//
// The CLI is THIN: it only sequences the injected stages and renders the trajectory. All the intelligence (what
// a run/fix/memorize IS) lives in the injected stages; all the control flow / bounds / early-stop / circuit-
// breaker live in core's runOptimizeLoop. `scoreRun` is injectable (deps) so the composition is testable.
//
// LONG-HORIZON SEAM (the STOP, 2026-07-01) — this `--rounds` path is ONE generation. The long-horizon OUTER loop
// (core `runLongHorizon`) wraps it: each GENERATION runs this multi-round loop, then an INJECTED `redesign`
// subgraph analyzes the run history and AUTHORS the next workflow's blueprint (analyze past nodes → design future
// nodes), and the loop continues on that new template. To wire it here later: (1) add an optional `redesign?`
// stage to `OptimizeBinding` (product-side, the deferred self-design subgraph), (2) recognize a `--generations N`
// flag, (3) compose `runLongHorizon({ runGeneration: (g, dir) => <this loop over dir>, redesign: binding.redesign },
// { templateDir, maxGenerations })`. The core contract + driver are BUILT + tested (long-horizon.ts); the redesign
// subgraph is the deferred piece. Until then, this file stays single-generation (the honest stop).

import { runOptimizeLoop, memorize, renderOptimizeEvent } from '@piflow/core';
import type { OptimizeLoopStages, OptimizeEventSink, Defect } from '@piflow/core';
import {
  loadBinding, scoreTriageEnrich, makeFixGateRunner, type OptimizeBinding, type FixGatePolicy, type OptimizeFixDeps,
} from './optimize-fix.js';

export interface ParsedOptimizeLoopArgs {
  binding: string;
  /** N — the run-count BUDGET ceiling (default 1). */
  rounds: number;
  /** stop after this many CONSECUTIVE rounds with 0 accepted edits (off when unset). */
  stalledPatience?: number;
  /** circuit-breaker: trip after this many CONSECUTIVE rounds whose stage threw (core default 2 when unset). */
  errorBudget?: number;
  stagingDir?: string;
  autoAdopt: boolean;
  editBudget?: number;
  tokenBudget?: number;
  fixCycleCeiling?: number;
  /** worklist substring filter — process ONLY defects whose node id contains it. */
  node?: string;
  /** stream the live progress (per-fix AND round-boundary events) as the loop runs. */
  watch: boolean;
  /** with --watch, emit each event as a JSON line instead of the human render. */
  watchJson: boolean;
}

export function parseOptimizeLoopArgs(argv: string[]): ParsedOptimizeLoopArgs {
  const out: ParsedOptimizeLoopArgs = { binding: '', rounds: 1, autoAdopt: false, watch: false, watchJson: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--binding') out.binding = argv[++i] ?? '';
    else if (k === '--rounds') out.rounds = Number(argv[++i]);
    else if (k === '--stalled-patience') out.stalledPatience = Number(argv[++i]);
    else if (k === '--error-budget') out.errorBudget = Number(argv[++i]);
    else if (k === '--staging-dir') out.stagingDir = argv[++i];
    else if (k === '--auto-adopt') out.autoAdopt = true;
    else if (k === '--edit-budget') out.editBudget = Number(argv[++i]);
    else if (k === '--token-budget') out.tokenBudget = Number(argv[++i]);
    else if (k === '--fix-cycle-ceiling') out.fixCycleCeiling = Number(argv[++i]);
    else if (k === '--node') out.node = argv[++i];
    else if (k === '--watch') out.watch = true;
    else if (k === '--watch-json') { out.watch = true; out.watchJson = true; } // --watch-json implies --watch
    else if (k.startsWith('--')) { /* ignore unknown flags */ }
    // positionals: the loop's run dirs come from the binding's `run`, so a bare rundir is not used here.
  }
  return out;
}

export async function runOptimizeLoopCli(argv: string[], deps: OptimizeFixDeps = {}): Promise<void> {
  const args = parseOptimizeLoopArgs(argv);
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  if (!args.binding) {
    process.stderr.write('piflowctl optimize --rounds: --binding <module> is required (the product run/oracle/fixer; not in @piflow/core).\n');
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(args.rounds) || args.rounds < 1) {
    process.stderr.write('piflowctl optimize --rounds: N must be a positive integer.\n');
    process.exitCode = 2;
    return;
  }

  const binding: OptimizeBinding = await loadBinding(args.binding);
  // The `run` stage is PRODUCT-side and REQUIRED for a multi-round loop — do NOT fake it. `--rounds > 1` without
  // `run` is a hard error; a single already-finished run belongs on the single-shot `--fix <rundir>` path.
  if (typeof binding.run !== 'function') {
    const hint = args.rounds > 1
      ? 'A multi-round loop needs the product to RUN its workflow each round (it cannot live in @piflow/core). '
        + 'Add a `run` export to the binding, or use single-shot `--fix <rundir>` for one already-finished run.'
      : 'The loop needs the product to RUN its workflow (add a `run` export), or use `--fix <rundir>` for a finished run.';
    process.stderr.write(`piflowctl optimize --rounds ${args.rounds}: the binding '${args.binding}' exports no \`run(round)\` stage.\n${hint}\n`);
    process.exitCode = 2;
    return;
  }
  const run = binding.run;

  // --watch: one shared sink for BOTH the per-fix events (emitted inside fixGate) and the round-boundary events
  // (emitted by the loop). Fire-and-forget; a throwing print never breaks the loop (core swallows sink throws).
  const onEvent: OptimizeEventSink | undefined = args.watch
    ? (e) => print(args.watchJson ? JSON.stringify(e) : renderOptimizeEvent(e))
    : undefined;
  const policy: FixGatePolicy = {
    autoAdopt: args.autoAdopt,
    ...(args.editBudget !== undefined ? { editBudget: args.editBudget } : {}),
    ...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
    ...(args.fixCycleCeiling !== undefined ? { fixCycleCeiling: args.fixCycleCeiling } : {}),
  };
  const scoreOpts = {
    ...(deps.scoreRun ? { scoreRun: deps.scoreRun } : {}),
    ...(args.node ? { node: args.node } : {}),
  };

  // The loop's `fixGate(defects, buffer, round)` signature does NOT thread the run dir, but the trace miner must
  // bind to THIS round's dir. The loop drives one round to completion before the next (it awaits each stage), so
  // capturing the dir the `run` stage returned in a per-loop ref is safe (no round interleaving). `run` sets it.
  let currentRunDir = '';

  // Compose the injected round stages — the loop calls these in order and is blind to their internals. Each is a
  // reuse of the SAME core composition the single-shot path uses (no divergent duplicate). `R` = the round's run
  // dir the product `run` returns; scoreAndTriage/fixGate/memorize consume it (fixGate binds the trace miner to it).
  const stages: OptimizeLoopStages<string> = {
    run: async (round: number) => { currentRunDir = await run(round); return currentRunDir; },
    scoreAndTriage: async (runDir: string): Promise<Defect[]> => {
      const { defects } = await scoreTriageEnrich(runDir, scoreOpts);
      return defects;
    },
    // The trace miner is bound to THIS round's run dir (captured from the run stage; the loop cannot thread it).
    fixGate: (defects: Defect[], rejectedBuffer: Set<string>) => makeFixGateRunner(binding, currentRunDir, policy, onEvent)(defects, rejectedBuffer),
    // MEMORIZE (Leg-A): persist the round's tier0-signature lessons so recurrence carries ACROSS rounds. Off the
    // critical path — re-derive the score pass memorize needs (idempotent) and never let a write failure sink a round.
    memorize: async (runDir: string) => {
      try {
        const { scores, defects, templateDir } = await scoreTriageEnrich(runDir, scoreOpts);
        memorize(scores, defects, { runDir, templateDir });
      } catch { /* memory is advisory; a write failure never fails the round */ }
    },
  };

  const result = await runOptimizeLoop(stages, {
    rounds: args.rounds,
    ...(args.stalledPatience !== undefined ? { stalledPatience: args.stalledPatience } : {}),
    ...(args.errorBudget !== undefined ? { errorBudget: args.errorBudget } : {}),
    ...(onEvent ? { onEvent } : {}),
  });

  // The round-by-round trajectory + the stop reason + rounds-run — what the human reads at the end.
  print(`optimize --rounds ${args.rounds}: ${result.roundsRun} round(s) run, stopped: ${result.stoppedReason}`);
  for (const t of result.trajectory) print(`  round ${t.round}: accepted=${t.accepted}/${t.attempted}`);
  process.stderr.write(
    `\noptimize --rounds: ${result.roundsRun} round(s), stopped ${result.stoppedReason}; `
    + `${result.trajectory.reduce<number>((a, t) => a + t.accepted, 0)} edit(s) accepted across the run; nothing landed live (adopt is a separate step).\n`,
  );
}

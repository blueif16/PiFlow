// ── launchRun — ACTIVATE a pi workflow run from an upstream orchestrator ─────────────────────────────
// The one "start the workflow" primitive. It spawns the canonical `piflowctl run <templateDir>` as a
// DETACHED child (so the run outlives the request/graph-invocation that started it) and hands back the
// run id + the physical run dir — `<runDir>/.pi/run.json` is exactly what `watchRun(runDir)` tails. It
// owns NO status logic and NO product/domain knowledge: it only knows how to invoke the engine's CLI.
//
// `--out <runDir>` pins the run root so the caller KNOWS where `.pi/` lands (cli/run.ts: outDir = --out).
// The provider/thinking/sandbox/from-until flags are caller-supplied via `extraArgs` (the canonical
// invocation is pinned by the piflow-start skill, never reconstructed here).

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';

export interface LaunchOpts {
  /** The structured workflow template dir (e.g. `.piflow/<wf>/template`). */
  templateDir: string;
  /** `--arg k=v` pairs handed to the run (e.g. the prompt + projectDir). */
  args?: Record<string, string>;
  /** Run id; default a time-sortable random id. Also the leaf of the default run dir. */
  runId?: string;
  /** Base dir the run dir is created under: `<runsHome>/<runId>`. Default `out`. */
  runsHome?: string;
  /** The piflowctl CLI bin. Default the npm-linked global `piflowctl`. */
  bin?: string;
  /** Spawn cwd (the workspace/repo root the template tokens resolve against). Default `process.cwd()`. */
  cwd?: string;
  /** Pass-through CLI flags (e.g. `['--provider','gw','--thinking','low','--sandbox','local']`). */
  extraArgs?: string[];
}

export interface LaunchHandle {
  runId: string;
  /** The physical run root; `watchRun(runDir)` tails `<runDir>/.pi/run.json`. */
  runDir: string;
  child: ChildProcess;
}

/** A time-sortable, filesystem-safe run id: `<prefix>-<base36 time><8 hex rand>`. */
export function newRunId(prefix = 'run'): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}-${ts}${rand}`;
}

/** Spawn `piflowctl run <templateDir> --out <runDir> [--arg k=v]... [extraArgs]` detached; return handles. */
export function launchRun(opts: LaunchOpts): LaunchHandle {
  const runId = opts.runId ?? newRunId();
  const cwd = opts.cwd ?? process.cwd();
  const runDir = path.resolve(cwd, opts.runsHome ?? 'out', runId);

  const argv = ['run', opts.templateDir, '--out', runDir];
  for (const [k, v] of Object.entries(opts.args ?? {})) argv.push('--arg', `${k}=${v}`);
  if (opts.extraArgs?.length) argv.push(...opts.extraArgs);

  const child = spawn(opts.bin ?? 'piflowctl', argv, { cwd, detached: true, stdio: 'ignore' });
  child.unref();
  return { runId, runDir, child };
}

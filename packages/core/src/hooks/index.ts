// The deterministic hook runner — pre/post plumbing around a node (never an LLM). Honors `when`
// (always / on-success / on-failure), `idempotent` skip-when-fresh (output mtime ≥ newest input),
// and `failure` (block ⇒ throw, warn ⇒ collect). A hook's declared inputs/outputs are its DAG edge
// AND its resume key, so a fresh hook is safely skipped on `--from` replay.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Hook, HookContext } from '../types.js';

export interface HookReport {
  id: string;
  ran: boolean;
  skipped?: 'when' | 'idempotent';
  ok: boolean;
  error?: string;
}

export interface RunHooksOpts {
  /** The node's outcome — selects which `when` hooks fire. */
  outcome: 'success' | 'failure';
  /** The `${RUN}` output root handed to each hook's `HookContext`. Defaults to `ctx.workspace`. */
  projectBase?: string;
  /** Runs a shell-string hook; default spawns `bash -c` in the workspace. */
  runShell?: (cmd: string, ctx: HookContext) => Promise<{ code: number; stderr: string }>;
  /** Returns a path's mtime in ms, or null if missing; default uses fs. */
  mtime?: (absPath: string) => Promise<number | null>;
}

const fires = (hook: Hook, outcome: 'success' | 'failure'): boolean =>
  hook.when === 'always' ||
  (hook.when === 'on-success' && outcome === 'success') ||
  (hook.when === 'on-failure' && outcome === 'failure');

const defaultMtime = async (absPath: string): Promise<number | null> => {
  try {
    return (await fs.stat(absPath)).mtimeMs;
  } catch {
    return null;
  }
};

const defaultShell = (workspace: string, cmd: string): Promise<{ code: number; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, { cwd: workspace, shell: true });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (e) => resolve({ code: 1, stderr: stderr + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
  });

async function isFresh(hook: Hook, ctx: HookContext, mtime: (p: string) => Promise<number | null>): Promise<boolean> {
  if (hook.idempotent === false || hook.outputs.length === 0) return false;
  const outs = await Promise.all(hook.outputs.map((o) => mtime(path.resolve(ctx.workspace, o))));
  if (outs.some((m) => m === null)) return false; // a declared output is missing → must run
  const ins = await Promise.all(hook.inputs.map((i) => mtime(path.resolve(ctx.workspace, i))));
  const newestIn = Math.max(0, ...ins.filter((m): m is number => m !== null));
  const oldestOut = Math.min(...(outs as number[]));
  return oldestOut >= newestIn; // outputs at least as new as inputs ⇒ fresh ⇒ skip
}

/** Run the hooks for one phase. Throws on a blocking failure; otherwise returns per-hook reports. */
export async function runHooks(hooks: Hook[] | undefined, ctx: HookContext, opts: RunHooksOpts): Promise<HookReport[]> {
  const reports: HookReport[] = [];
  const mtime = opts.mtime ?? defaultMtime;
  const shell = opts.runShell ?? ((cmd: string) => defaultShell(ctx.workspace, cmd));
  const projectBase = opts.projectBase ?? ctx.workspace; // ${RUN} defaults to the workspace root
  for (const hook of hooks ?? []) {
    if (!fires(hook, opts.outcome)) {
      reports.push({ id: hook.id, ran: false, skipped: 'when', ok: true });
      continue;
    }
    if (await isFresh(hook, ctx, mtime)) {
      reports.push({ id: hook.id, ran: false, skipped: 'idempotent', ok: true });
      continue;
    }
    const hctx: HookContext = { workspace: ctx.workspace, projectBase, inputs: hook.inputs, outputs: hook.outputs };
    let ok = true;
    let error: string | undefined;
    try {
      if (typeof hook.run === 'string') {
        const r = await shell(hook.run, hctx);
        if (r.code !== 0) {
          ok = false;
          error = r.stderr.trim() || `exit ${r.code}`;
        }
      } else {
        await hook.run(hctx);
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    const report: HookReport = { id: hook.id, ran: true, ok };
    if (error !== undefined) report.error = error;
    reports.push(report);
    if (!ok && (hook.failure ?? 'block') === 'block') {
      throw new Error(`hook "${hook.id}" failed (blocking): ${error}`);
    }
  }
  return reports;
}

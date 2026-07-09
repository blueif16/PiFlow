// `piflowctl snapshot list <run>` / `snapshot restore <run> <stageIdxOrTag>` — operate on a run's RUN-DIR
// GIT CHECKPOINTS (the external `.piflow/<wf>/checkpoints/<id>.git` store a `run --checkpoints` fills at each
// stage barrier; distinct from the HITL `checkpoint`). `list` shows the `pre-stage-<k>` tags; `restore` rolls
// the run dir — tree, `.pi/journal.json`, and state — back to a stage's ENTRY IN PLACE, so a plain re-run of
// the same id (`piflowctl run <template> --run <id>`) then re-executes from that stage via the journal, with
// no `--from` needed and `node_modules` (ignored) untouched.
//
// `<run>` resolves via the SAME `resolveNodeRunDir` every other run-scoped verb uses — path, canonical
// `.piflow/<wf>/runs/<id>`, or `out/<id>`. All git lives behind the core `snapshot*` primitives (best-effort
// on the run path; here a restore failure is surfaced as a loud non-zero exit — the user asked for it).

import {
  snapshotGitDir,
  snapshotExists,
  snapshotList,
  snapshotRestore,
  resolveStageRef,
} from '@piflow/core';
import { resolveNodeRunDir } from './node.js';

/** Injection seam for tests (resolve/list/restore + the two sinks). */
export interface SnapshotDeps {
  resolveRunDir?: (run: string, cwd?: string) => string;
  list?: typeof snapshotList;
  restore?: typeof snapshotRestore;
  print?: (s: string) => void;
  error?: (s: string) => void;
}

/**
 * `piflowctl snapshot <list|restore> …`. Returns the process exit code (0 ok, 1 on a usage/resolve/git
 * failure). PURE of process side effects when `deps` inject the sinks (unit-testable).
 */
export async function runSnapshotCli(argv: string[], deps: SnapshotDeps = {}): Promise<number> {
  const resolveRunDir = deps.resolveRunDir ?? ((run: string, cwd?: string) => resolveNodeRunDir({ run, cwd }));
  const list = deps.list ?? snapshotList;
  const restore = deps.restore ?? snapshotRestore;
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const error = deps.error ?? ((s: string) => process.stderr.write(s + '\n'));

  const [verb, run, ref] = argv;
  if (!verb || (verb !== 'list' && verb !== 'restore')) {
    error('piflowctl snapshot: usage — piflowctl snapshot list <run> | piflowctl snapshot restore <run> <stageIdxOrTag>');
    return 1;
  }
  if (!run) {
    error(`piflowctl snapshot ${verb}: a <run> (id or path) is required.`);
    return 1;
  }

  let runDir: string;
  try {
    runDir = resolveRunDir(run);
  } catch (e) {
    error((e as Error).message);
    return 1;
  }
  const gitDir = snapshotGitDir(runDir);

  if (verb === 'list') {
    if (!snapshotExists(gitDir)) {
      print(`piflowctl snapshot: no checkpoint store for "${run}" (run it with --checkpoints to enable per-stage snapshots).`);
      return 0;
    }
    const entries = list(gitDir, runDir);
    if (!entries.length) {
      print(`piflowctl snapshot: store exists for "${run}" but holds no pre-stage-* tags yet.`);
      return 0;
    }
    print(`checkpoints for ${run} (${runDir}):`);
    for (const e of entries) print(`  ${e.tag.padEnd(16)} ${e.sha}  ${e.subject}`);
    print(`restore any with: piflowctl snapshot restore ${run} <stageIdx>`);
    return 0;
  }

  // verb === 'restore'
  if (!ref) {
    error(`piflowctl snapshot restore: a <stageIdxOrTag> is required (e.g. 2 or pre-stage-2 — see 'snapshot list ${run}').`);
    return 1;
  }
  if (!snapshotExists(gitDir)) {
    error(`piflowctl snapshot restore: no checkpoint store for "${run}" (was it run with --checkpoints?).`);
    return 1;
  }
  const resolvedRef = resolveStageRef(ref);
  const res = restore(gitDir, runDir, resolvedRef);
  if (!res.ok) {
    error(`piflowctl snapshot restore: git checkout "${resolvedRef}" failed — ${res.error ?? 'unknown error'}.`);
    return 1;
  }
  print(`piflowctl snapshot: restored ${run} to ${resolvedRef} (tree + journal + state rolled back; node_modules untouched).`);
  print(`re-run from that stage with: piflowctl run <template> --run ${run}`);
  return 0;
}

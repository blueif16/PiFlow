// Run-dir git CHECKPOINTS — an EXTERNAL git store whose work-tree is the accumulating run dir, snapshotted
// at each STAGE BARRIER. Replaying any node = restoring its stage's ENTRY tree. Stage grain is exact: all
// parallel nodes in a stage are released together from the same barrier state, so "the instant node N began"
// == "its stage's entry tree" — zero per-artifact reasoning (the per-artifact owns-reset `spawnChildRun`
// leans on can't reset downstream pollution; a whole-tree checkout can't leave any).
//
// Why the store is EXTERNAL (`.piflow/<wf>/checkpoints/<id>.git`, a SIBLING of `runs/`, NOT a `.git` inside
// the run dir): the sandbox jail grants a node only {workdir + owns} (seatbelt.ts) — a jailed node would
// kernel-EPERM on an external GIT_DIR, so only the UNJAILED runner ever writes it; and `packRunDir` (which
// only walks the run dir) never bundles it into a migration. The runner (unjailed) spawns `git` directly.
//
// Best-effort EVERYWHERE on the run path: every primitive is try/catch → `{ ok:false, error }`, so a broken
// or absent `git` NEVER fails a real run (mirrors the best-effort posture of `writeNodePid`). Every op is a
// blocking `execFileSync` (argv array, no shell → no escaping) — so the barrier commits within one process
// never interleave, and no async write-chain (journal.ts's `writeChains`) is needed here.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

/**
 * `$GIT_DIR/info/exclude` entries — the ONLY things the checkpoint store must NOT track. `node_modules/` is
 * huge + regenerable (it survives a checkout in place, untouched). `.pi/run.lock` / `.pi/freeze` are
 * HOST-LOCAL coordination sentinels (mirrors migrate.ts's `BUNDLE_EXCLUDE`) — rolling them back would make a
 * restored run think it's already locked / re-park. EVERYTHING ELSE — the whole `.pi/` namespace
 * (journal.json, journal.bak, state.json, run.json, nodes/**, sessions/) — IS tracked, so a checkout rolls
 * the journal + state back WITH the tree (load-bearing: that is what makes seedFromJournal see the reverted
 * prefix on the next resume).
 */
export const CHECKPOINT_IGNORE: readonly string[] = ['node_modules/', '.pi/run.lock', '.pi/freeze'];

/** The result of a checkpoint op — best-effort, never throws on the run path. */
export interface SnapshotResult {
  ok: boolean;
  /** The git failure message when `ok:false` (a broken/absent git, a bad ref). */
  error?: string;
}

/**
 * The external checkpoint git dir for a run dir: `.piflow/<wf>/checkpoints/<id>.git` — two levels up from the
 * run dir (`.piflow/<wf>/runs/<id>`) + `checkpoints/<id>.git`, matching run.ts's canonical `runs/` layout. A
 * SIBLING of `runs/`, so it is OUTSIDE the run dir (the jail workdir) — see the module header.
 */
export function snapshotGitDir(runDir: string): string {
  const dir = path.resolve(runDir);
  return path.join(path.dirname(path.dirname(dir)), 'checkpoints', `${path.basename(dir)}.git`);
}

/** The per-stage tag/ref — `pre-stage-<k>`, k = the GLOBAL 0-based stage index (into `wf.stages`). */
export function stageTag(stageIdx: number): string {
  return `pre-stage-${stageIdx}`;
}

/** A checkpoint store EXISTS for this git dir (an initialized run). The child-run consume site's gate. */
export function snapshotExists(gitDir: string): boolean {
  return existsSync(path.join(gitDir, 'HEAD'));
}

let materializeSeq = 0;

/** Run one `git` against the external store (git dir + work tree via env, argv array, no shell). Blocking. */
function git(gitDir: string, workTree: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extraEnv,
    },
  }).toString();
}

/**
 * Lazily initialize the checkpoint store (idempotent — a no-op once `$GIT_DIR/HEAD` exists). Creates the git
 * dir, pins a SCOPED identity (never the user's), turns OFF gpg-signing + the detached-HEAD advice (a restore
 * detaches HEAD by design — the checkpoints are TAGS, unaffected), and writes `info/exclude`. Best-effort.
 */
export function snapshotInit(gitDir: string, workTree: string): SnapshotResult {
  try {
    if (!snapshotExists(gitDir)) {
      mkdirSync(gitDir, { recursive: true });
      git(gitDir, workTree, ['init', '-q']);
      git(gitDir, workTree, ['config', 'user.email', 'checkpoints@piflow.local']);
      git(gitDir, workTree, ['config', 'user.name', 'piflow-checkpoints']);
      git(gitDir, workTree, ['config', 'commit.gpgsign', 'false']);
      git(gitDir, workTree, ['config', 'advice.detachedHead', 'false']);
      mkdirSync(path.join(gitDir, 'info'), { recursive: true });
      writeFileSync(path.join(gitDir, 'info', 'exclude'), `${CHECKPOINT_IGNORE.join('\n')}\n`);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Commit the WHOLE run-dir work tree as the ENTRY snapshot for `stageIdx`, tagged `pre-stage-<stageIdx>`. The
 * tag is force-moved (`tag -f`) so a replayed re-run re-stamps it onto the fresh commit. `--allow-empty` so a
 * stage that changed nothing on disk still yields a checkpoint (one commit per stage). `nodeIds` (the ids
 * ABOUT to run at this stage) ride the message for traceability. Best-effort. Init first if needed.
 */
export function snapshotCommit(gitDir: string, workTree: string, stageIdx: number, nodeIds: readonly string[]): SnapshotResult {
  try {
    const init = snapshotInit(gitDir, workTree);
    if (!init.ok) return init;
    git(gitDir, workTree, ['add', '-A']);
    const label = nodeIds.length ? `[${nodeIds.join(', ')}]` : '(final)';
    git(gitDir, workTree, ['commit', '-q', '--allow-empty', '-m', `${stageTag(stageIdx)}: entry tree before ${label}`]);
    git(gitDir, workTree, ['tag', '-f', stageTag(stageIdx)]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Restore a run dir IN PLACE to a checkpoint's entry tree: `git checkout -f <ref>` — every TRACKED file
 * reverts (a downstream file written in a LATER stage is REMOVED; `.pi/journal.json` + state.json roll back),
 * while IGNORED files (`node_modules/`) are left untouched. Moves HEAD (detached) — harmless: the checkpoints
 * are tags. `ref` = `pre-stage-<k>` (or any commit-ish). Best-effort (a bad ref ⇒ `ok:false`).
 */
export function snapshotRestore(gitDir: string, workTree: string, ref: string): SnapshotResult {
  try {
    git(gitDir, workTree, ['checkout', '-f', ref]);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Materialize a checkpoint's entry tree into a FRESH (empty) dest dir WITHOUT moving the store's HEAD/index —
 * via a throwaway `GIT_INDEX_FILE` + `read-tree`/`checkout-index`. Used by the child-run replay: the dest is
 * a freshly-minted sibling, so there is nothing to delete, and the parent store (a finished run) is never
 * mutated. `ref` = `pre-stage-<k>`. Best-effort.
 */
export function snapshotMaterialize(gitDir: string, destDir: string, ref: string): SnapshotResult {
  const tmpIndex = path.join(gitDir, `.materialize.${process.pid}.${materializeSeq++}.index`);
  try {
    mkdirSync(destDir, { recursive: true });
    git(gitDir, destDir, ['read-tree', ref], { GIT_INDEX_FILE: tmpIndex });
    git(gitDir, destDir, ['checkout-index', '-a', '-f'], { GIT_INDEX_FILE: tmpIndex });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    try { rmSync(tmpIndex, { force: true }); } catch { /* best-effort */ }
  }
}

/** One listed checkpoint (a `pre-stage-*` tag). */
export interface SnapshotEntry {
  tag: string;
  stageIdx: number;
  sha: string;
  subject: string;
}

/**
 * List the checkpoint tags (`pre-stage-*`), ascending by stage index. `[]` when the store is absent — the
 * CLI `snapshot list` surface. Read-only (no work-tree touch).
 */
export function snapshotList(gitDir: string, workTree: string): SnapshotEntry[] {
  if (!snapshotExists(gitDir)) return [];
  try {
    const out = git(gitDir, workTree, [
      'for-each-ref',
      '--format=%(refname:short)%09%(objectname:short)%09%(subject)',
      'refs/tags/pre-stage-*',
    ]);
    const rows: SnapshotEntry[] = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [tag, sha, ...rest] = line.split('\t');
      const m = /^pre-stage-(\d+)$/.exec(tag ?? '');
      if (!m) continue;
      rows.push({ tag, stageIdx: Number(m[1]), sha: sha ?? '', subject: rest.join('\t') });
    }
    return rows.sort((a, b) => a.stageIdx - b.stageIdx);
  } catch {
    return [];
  }
}

/**
 * Resolve a user `<stageIdxOrTag>` (e.g. `2` or `pre-stage-2`) to a `pre-stage-<k>` ref. A bare integer maps
 * to `pre-stage-<n>`; a string already starting with `pre-stage-` passes through; anything else is returned
 * verbatim (the caller lets git reject a bad ref). PURE — the CLI restore verb's arg normalizer.
 */
export function resolveStageRef(stageIdxOrTag: string): string {
  const s = stageIdxOrTag.trim();
  if (/^\d+$/.test(s)) return stageTag(Number(s));
  return s;
}

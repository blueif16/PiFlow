// ─────────────────────────────────────────────────────────────────────────────
// DRIVER-MERGE (the FILESYSTEM-merge family) — concat | reconcile | fold | run. Ported from game-omni
// pi-runner/hooks/merge.mjs; behavior-preserving for the transforms. The state change: the run.mjs
// RUN_CWD/ROOT fallback chain + the `{root}` cmd token are retired — relative paths resolve under the
// explicit `projectBase` (= the resolved `{{RUN}}`), and `run`'s `{project}` token substitutes it.
//
// SCOPE NOTE (flagged, not silently stubbed): the optional ajv `schema` re-validation gate on `reconcile`
// is NOT ported — the draft-2020-12 validator factory + its node_modules resolution are a game-omni
// consumer concern. The MERGE itself is byte-preserving; a consumer that wants a post-merge schema gate
// runs the core `validateArtifactSchemas` seam separately.
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, projJson, drillPath, absUnder } from './util.js';

// (M6 · #13) SAME-TARGET FOLD BARRIER. `fold` is a read-modify-write on the target file: read it, SET one
// key, write the WHOLE object back. When N folds into the SAME target run concurrently (the runner runs a
// parallel stage's POST merge ops via `Promise.all`), all read the same base before any write lands, so the
// last writer clobbers the others — a lost update (#13). We serialize the read-modify-write per ABSOLUTE
// TARGET PATH via a chained-promise lock: folds into the SAME file run one-at-a-time (each sees the prior's
// write), while folds into DISJOINT files keep running in parallel (the lock keys on the path, never global).
const foldLocks = new Map<string, Promise<unknown>>();
function withTargetLock<T>(targetAbs: string, fn: () => Promise<T>): Promise<T> {
  const prev = foldLocks.get(targetAbs) ?? Promise.resolve();
  // Chain after the prior holder; swallow its rejection so one failed fold never poisons the queue.
  const next = prev.then(fn, fn);
  // Keep the chain tail current; drop the entry once it is the tail and settled (avoid an unbounded map).
  foldLocks.set(targetAbs, next);
  void next.catch(() => {}).finally(() => {
    if (foldLocks.get(targetAbs) === next) foldLocks.delete(targetAbs);
  });
  return next;
}

/** One merge op result. `wrote` is the on-disk effect; `failed` flags a non-zero `run` exit. */
export interface MergeResult {
  op: string;
  to?: string;
  wrote: boolean;
  skipped?: string;
  merged?: number;
  reconciled?: number;
  into?: string;
  failed?: boolean;
  exit?: number;
  stderr?: string;
  cmd?: string;
  stdout?: string;
  note?: string;
}

/** A `reconcile` field spec: a bare field name, or `{ name, when:{ field, equals } }` (conditional copy). */
type ReconcileField = string | { name: string; when?: { field: string; equals: unknown } };

/** Apply ONE filesystem-merge op under `projectBase`. */
export async function applyMergeOp(
  opSpec: Record<string, unknown>,
  projectBase: string,
): Promise<MergeResult> {
  // ---- concat: glob → to, each under a heading, stable lexical-by-path, idempotent overwrite ----
  if (opSpec.concat && typeof opSpec.concat === 'object') {
    const { glob, to, heading = '## {name}' } = opSpec.concat as { glob: string; to: string; heading?: string };
    const toAbs = absUnder(projectBase, to);
    const dir = path.dirname(glob);
    const pat = path.basename(glob);
    const reSrc = '^' + pat.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$';
    const re = new RegExp(reSrc);
    const dirAbs = absUnder(projectBase, dir);
    let names: string[] = [];
    try {
      names = await fs.readdir(dirAbs);
    } catch {
      /* missing dir ⇒ no matches */
    }
    const toBase = path.basename(toAbs);
    const matched = names.filter((n) => re.test(n) && n !== toBase).sort();
    if (!matched.length) return { op: 'concat', to, wrote: false, skipped: `no files match ${glob}`, merged: 0 };
    const parts: string[] = [];
    for (const n of matched) {
      const relPath = path.join(dir, n).replace(/^\.\//, '');
      let body = '';
      try {
        body = await fs.readFile(path.join(dirAbs, n), 'utf8');
      } catch {
        continue;
      }
      const head = heading.replaceAll('{name}', n).replaceAll('{path}', relPath);
      parts.push(`${head}\n\n${body.replace(/\s+$/, '')}`);
    }
    await ensureDir(path.dirname(toAbs));
    await fs.writeFile(toAbs, parts.join('\n\n') + '\n');
    return { op: 'concat', to, wrote: true, merged: matched.length };
  }

  // ---- reconcile: from.<keys> → to.slots[].<fields> on matching key; keys/order untouched ----
  if (opSpec.reconcile && typeof opSpec.reconcile === 'object') {
    const {
      from,
      to,
      key = 'slot',
      fields = [],
      arrayAt = 'slots',
      fromAt = 'slots',
    } = opSpec.reconcile as {
      from: string;
      to: string;
      key?: string;
      fields?: ReconcileField[];
      arrayAt?: string;
      fromAt?: string;
    };
    const toAbs = absUnder(projectBase, to);
    let toJson: Record<string, unknown>;
    try {
      toJson = JSON.parse(await fs.readFile(toAbs, 'utf8'));
    } catch (e) {
      return { op: 'reconcile', to, wrote: false, skipped: `target unreadable: ${(e as Error).message}` };
    }
    const fromAbs = absUnder(projectBase, from);
    let fromMap: unknown;
    try {
      fromMap = drillPath(JSON.parse(await fs.readFile(fromAbs, 'utf8')), fromAt);
    } catch (e) {
      return {
        op: 'reconcile',
        to,
        wrote: false,
        skipped: `source unreadable: ${(e as Error).message} (target left unchanged)`,
      };
    }
    if (!fromMap || typeof fromMap !== 'object')
      return { op: 'reconcile', to, wrote: false, skipped: `source "${from}" has no .${fromAt} object` };
    const rows = drillPath(toJson, arrayAt);
    if (!Array.isArray(rows))
      return { op: 'reconcile', to, wrote: false, skipped: `target has no .${arrayAt} array` };
    const fromObj = fromMap as Record<string, Record<string, unknown>>;
    let reconciled = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const id = r[key];
      const src = id != null ? fromObj[id as string] : undefined;
      if (!src || typeof src !== 'object') continue;
      let touched = false;
      for (const f of fields) {
        const name = typeof f === 'string' ? f : f.name;
        if (!name) continue;
        if (typeof f === 'object' && f.when) {
          if (src[f.when.field] !== f.when.equals) continue;
        }
        if (name in src) {
          r[name] = src[name];
          touched = true;
        }
      }
      if (touched) reconciled++;
    }
    await fs.writeFile(toAbs, projJson(toJson));
    return { op: 'reconcile', to, wrote: true, reconciled };
  }

  // ---- fold: a fragment JSON object → to.<into> (SET to[into] = the parsed fragment) ----
  if (opSpec.fold && typeof opSpec.fold === 'object') {
    const { from, to, into } = opSpec.fold as { from?: string; to?: string; into?: string };
    if (!from || !to || !into) return { op: 'fold', to, wrote: false, skipped: 'fold needs { from, to, into }' };
    const toAbs = absUnder(projectBase, to);
    // (M6 · #13) The read-modify-write runs under a per-target-path lock so N folds into the SAME file
    // serialize (each sees the prior's write) — no lost update — while disjoint targets stay parallel.
    return withTargetLock(toAbs, async () => {
      let toJson: Record<string, unknown>;
      try {
        toJson = JSON.parse(await fs.readFile(toAbs, 'utf8'));
      } catch (e) {
        return { op: 'fold', to, wrote: false, skipped: `target unreadable: ${(e as Error).message}` };
      }
      const fromAbs = absUnder(projectBase, from);
      let frag: unknown;
      try {
        frag = JSON.parse(await fs.readFile(fromAbs, 'utf8'));
      } catch (e) {
        return {
          op: 'fold',
          to,
          wrote: false,
          skipped: `fragment "${from}" unreadable: ${(e as Error).message} (target left unchanged)`,
        };
      }
      toJson[into] = frag;
      await fs.writeFile(toAbs, projJson(toJson));
      return { op: 'fold', to, wrote: true, into };
    });
  }

  // ---- run: execute a declared command — a deterministic GENERATE/derive step. `{project}` substitutes
  // projectBase. A BARE command (no separator) resolves via the interpreter/PATH, never <project>/cmd. ----
  if (opSpec.run && typeof opSpec.run === 'object') {
    const { cmd, args = [], cwd, note } = opSpec.run as { cmd?: string; args?: string[]; cwd?: string; note?: string };
    if (!cmd) return { op: 'run', wrote: false, skipped: 'run needs { cmd }' };
    const sub = (s: string): string => (typeof s === 'string' ? s.replace(/\{project\}/g, projectBase) : s);
    const subCmd = sub(cmd);
    const cmdAbs = path.isAbsolute(subCmd)
      ? subCmd
      : subCmd === 'node'
        ? process.execPath
        : !/[\\/]/.test(subCmd)
          ? subCmd
          : path.join(projectBase, subCmd);
    const argv = (Array.isArray(args) ? args : []).map(sub);
    const runCwd = cwd ? (path.isAbsolute(sub(cwd)) ? sub(cwd) : path.join(projectBase, sub(cwd))) : projectBase;
    const res = spawnSync(cmdAbs, argv, { cwd: runCwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const out = (res.stdout || '').toString().trim().split('\n').slice(-3).join(' | ');
    const err = (res.stderr || '').toString().trim().split('\n').slice(-3).join(' | ');
    if (res.error)
      return { op: 'run', wrote: false, failed: true, skipped: `spawn error: ${res.error.message}`, cmd: subCmd };
    if (res.status !== 0)
      // `stdout` rides here too (not just stderr) — a failing check script commonly reports its verdict on
      // stdout (stderr is reserved for actual errors), and the caller's failure-detail construction
      // (op-dispatch.ts's mergeFailureDetail) falls back to it when stderr is empty.
      return { op: 'run', wrote: false, failed: true, exit: res.status ?? 1, stderr: err.slice(0, 400), stdout: out.slice(0, 400), cmd: subCmd };
    return { op: 'run', wrote: true, exit: 0, cmd: subCmd, stdout: out.slice(0, 200), note: note || undefined };
  }

  return { op: 'unknown', wrote: false, skipped: 'no recognized op (concat|reconcile|fold|run)' };
}

/** A node's DRIVER-MERGE op set. */
export interface MergeSpec {
  ops: Record<string, unknown>[];
}

/** Run a node's DRIVER-MERGE ops (POST-node). Each op degrades gracefully. A null/no-ops spec ⇒ null. */
export async function runMerge(
  spec: MergeSpec | null | undefined,
  projectBase: string,
): Promise<{ ops: MergeResult[] } | null> {
  if (!spec || !Array.isArray(spec.ops)) return null;
  const ops: MergeResult[] = [];
  for (const opSpec of spec.ops) {
    try {
      ops.push(await applyMergeOp(opSpec, projectBase));
    } catch (e) {
      ops.push({ op: Object.keys(opSpec || {})[0] || '?', wrote: false, skipped: `error: ${(e as Error).message}` });
    }
  }
  return { ops };
}

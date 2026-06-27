// ─────────────────────────────────────────────────────────────────────────────
// DRIVER-SEED (the PRE-stage family) — deterministically stage a node's STARTING artifact before the
// model runs. Ported from game-omni pi-runner/hooks/seed.mjs; the ONLY change is that the {file:field}
// drill resolves its file path through the U7 logical-root resolver ({{RUN}}/{{WORKSPACE}}/{{state}})
// instead of the retired RUN_CWD-relative path.resolve — so a seed is relocation-invariant by construction.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveTokens, type ResolveCtx } from '../resolver.js';
import { drillPath } from './util.js';

/** One parsed seed: stage the artifact at `to` from the (token-bearing) source `from`. */
export interface Seed {
  to: string;
  from: string;
}

/**
 * Parse every `DRIVER-SEED: <dest> <= <src>` line (in order). The trailing boundary is a LOOKAHEAD, never
 * a consumed `\n` — three ADJACENT lines must all match (consuming the separator skips every other one).
 */
export function driverSeed(prompt: string): Seed[] {
  const re = /(?:^|\n)[ \t]*DRIVER-SEED:[ \t]*(\S+)[ \t]*<=[ \t]*(\S+)[ \t]*(?=\n|$)/g;
  const seeds: Seed[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt || ''))) seeds.push({ to: m[1], from: m[2] });
  return seeds;
}

// A `{file:field}` token — only the INNERMOST (no nested braces) matches, so nesting resolves inner→outer.
// `{{…}}` logical-root tokens are stripped FIRST (by the resolver), so by the time this runs the file path
// is already absolute and contains no `{{ }}`; a bare `{x:y}` (one open brace) is what remains.
const oneToken = /\{([^:{}]+):([^{}]+)\}/;

/**
 * Resolve a seed source: first the `{{RUN}}`/`{{WORKSPACE}}`/`{{state.*}}` logical-root tokens (via the
 * shared resolver — so the file path is absolute + relocation-invariant), then drill each `{file:field}`
 * token to a fixpoint (inner→outer). `{file:field}` reads the JSON at `file` and drills `field` as a dotted
 * path. An unresolvable token (missing file / absent field) is left VERBATIM (bounded passes, never throws).
 */
export function resolveSeedTokens(spec: string, ctx: ResolveCtx): string {
  // Phase 1 — the logical roots. A `{{state.*}}` token throws MissingChannelError if the channel is absent
  // (intentional: a seed that names a not-yet-promoted channel is a real wiring error, surfaced loudly).
  let out = resolveTokens(spec, ctx);
  // Phase 2 — the {file:field} drill, to a fixpoint (bounded passes guard a cycle).
  for (let pass = 0; pass < 8 && oneToken.test(out); pass++) {
    out = out.replace(new RegExp(oneToken, 'g'), (whole, file: string, field: string) => {
      try {
        // Re-root a RELATIVE inner {file:field} path against the WORKSPACE, not
        // process.cwd(). The outer {{…}} tokens already resolved to absolute paths,
        // but a bare readFileSync(relative) resolves against the LAUNCH dir — so a run
        // started outside the workspace (e.g. `piflowctl run` from the piflow repo root,
        // where cwd ≠ {{WORKSPACE}}) ENOENTs and the nested-token seed silently skips
        // (the "engine base ABSENT" → Claude-mode fallback). Mirrors the legacy
        // runner's path.resolve(runCwd, file); makes the drill relocation-invariant
        // exactly like the {{…}} roots already are.
        const abs = path.isAbsolute(file) ? file : path.resolve(ctx.workspace, file);
        const v = drillPath(JSON.parse(readFileSync(abs, 'utf8')), field.trim());
        return v == null ? whole : String(v);
      } catch {
        return whole;
      }
    });
  }
  return out;
}

/** The on-disk effect of one `stageSeed` call: whether the copy happened + the graceful reason it did not. */
export interface SeedResult {
  /** The (run-relative or absolute) dest, echoed for the caller's ledger. */
  to: string;
  /** True iff bytes were copied; false when skipped (dest already filled, or no source template). */
  staged: boolean;
  /** Graceful reason when `staged` is false. */
  reason?: string;
  /** True iff the source was a directory (copied recursively). */
  dir?: boolean;
}

/**
 * The seed PRE EXECUTOR (ports game-omni run.mjs:1517-1551). Stage one node's STARTING artifact at `to`
 * from the (token-bearing) source `from`, BEFORE the model runs — so the model FILLs leaves (file) or
 * skips a mechanical tree copy + explore (dir). Behavior, preserved:
 *  - `to` resolves under `runDir` (a relative dest; an absolute dest passes through);
 *  - `from` resolves through the U7 seed-token resolver ({{RUN}}/{{WORKSPACE}}/{{state.*}} then {file:field});
 *  - IDEMPOTENT — never clobber an already-staged copy on a resume: a FILE dest is "filled" when it exists
 *    with size > 0; a DIR dest is "filled" when EVERY top-level entry of the SOURCE already exists under it
 *    (a per-SOURCE test, so a base-into-a-populated-root still stages while a genuine re-stage skips);
 *  - a DIR source copies RECURSIVELY (overlay merges over base, second wins); a FILE source copies as a file;
 *  - an ABSENT source is a graceful skip (the node hand-builds), never a throw.
 */
export async function stageSeed(seed: Seed, ctx: ResolveCtx, runDir: string): Promise<SeedResult> {
  const toAbs = path.isAbsolute(seed.to) ? seed.to : path.resolve(runDir, seed.to);
  const fr = resolveSeedTokens(seed.from, ctx);
  const fromAbs = path.isAbsolute(fr) ? fr : path.resolve(runDir, fr);

  // Source existence + kind.
  let srcIsDir = false;
  let srcExists = false;
  try {
    srcIsDir = (await fs.stat(fromAbs)).isDirectory();
    srcExists = true;
  } catch {
    /* absent — handled below */
  }

  // Idempotency: is the dest already filled? (FILE: size>0; DIR: every source top-level entry present.)
  let destFilled = false;
  try {
    const ds = await fs.stat(toAbs);
    if (srcIsDir && ds.isDirectory()) {
      const want = await fs.readdir(fromAbs);
      const present = await Promise.all(want.map((e) => fs.stat(path.join(toAbs, e)).then(() => true).catch(() => false)));
      destFilled = want.length > 0 && present.every(Boolean);
    } else if (!srcIsDir) {
      destFilled = ds.size > 0;
    } // src dir vs dest file (or vice-versa) → not "filled"; the copy below resolves it
  } catch {
    /* dest absent ⇒ not filled */
  }

  if (destFilled) return { to: seed.to, staged: false, reason: 'dest present — not re-staging', dir: srcIsDir };
  if (!srcExists) return { to: seed.to, staged: false, reason: `no template at source (node hand-builds): ${fromAbs}`, dir: false };

  if (srcIsDir) {
    await fs.mkdir(toAbs, { recursive: true });
    // verbatimSymlinks: a seeded tree routinely contains node_modules with hundreds
    // of .bin/* symlinks (and pnpm-style self-referential links). DEREFERENCING them
    // (fs.cp's default) makes the copy slow AND throws EINVAL "cannot copy … to a
    // subdirectory of self" when a link resolves back into the tree. Copy links AS
    // links — correct for node_modules and relocation-invariant.
    await fs.cp(fromAbs, toAbs, { recursive: true, force: true, verbatimSymlinks: true });
  } else {
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.copyFile(fromAbs, toAbs);
  }
  return { to: seed.to, staged: true, dir: srcIsDir };
}

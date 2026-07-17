// stash.ts — RERUN FRESH-PRODUCTION STASH. A `node --rerun` target must PRODUCE its artifacts again,
// never "confirm" the prior attempt's bytes sitting in the run dir (the confirm-instead-of-produce trap,
// observed live: a rerun node sees its own filled artifact, runs its checklist against it, and submits ok
// without repairing anything). Before the target executes, its resolved WRITE SCOPE (`contract.owns`,
// token-resolved — the same surface child-run.ts resets for optimize replays) is MOVED into
// `<run>/.pi/stash/<node>/<stamp>/`, so seed hooks re-stage the skeleton and the node starts from fresh,
// empty content — while the prior bytes stay recoverable, never deleted.
//
// Scope guard: ONLY paths inside the run dir are stashed. An owns entry that token-resolves outside it
// (e.g. a `{{WORKSPACE}}` global-registration path) is SKIPPED — a rerun must never vandalize the repo.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { NodeSpec } from '../types.js';
import type { ResolveCtx } from '../workflow/resolver.js';
import { resolveNodeWriteScope } from './node-lifecycle.js';

/**
 * Strip an owns entry's trailing glob suffix (`/**`, `/*`, `**`) to its concrete directory/file — the
 * SAME normalization `checkParallelOwns` uses for collision detection (template/checks.ts). A glob-only
 * entry (e.g. `"**"`) normalizes to `''` — the caller MUST skip it (never resolves to the run root itself).
 */
export function ownsPath(glob: string): string {
  return glob.replace(/\/?\*+$/, '').replace(/\/+$/, '');
}

/** What a stash moved, for the console line + any future un-stash tooling. */
export interface StashResult {
  /** `<outDir>/.pi/stash/<nodeId>/<stamp>` — where the prior bytes now live. */
  stashDir: string;
  /** Run-dir-relative roots that were moved (post-`ownsPath` normalization). */
  stashed: string[];
}

/**
 * Move the node's existing owned artifacts out of the run dir into `.pi/stash/<node>/<stamp>/`,
 * preserving relative layout. No-op (returns null) when nothing owned exists on disk.
 */
export async function stashNodeOwns(
  outDir: string,
  node: NodeSpec,
  resolveCtx: ResolveCtx,
  stamp: string,
): Promise<StashResult | null> {
  const outRoot = path.resolve(outDir);
  const stashDir = path.join(outRoot, '.pi', 'stash', node.id, stamp);
  const stashed: string[] = [];
  for (const entry of resolveNodeWriteScope(node, resolveCtx)) {
    const rel = ownsPath(entry);
    if (!rel) continue; // glob-only ("**") — never the run root itself
    const abs = path.resolve(outRoot, rel);
    // Inside-the-run-dir guard (covers absolute-resolved entries and any `..` escape).
    if (abs !== outRoot && !abs.startsWith(outRoot + path.sep)) continue;
    if (abs === outRoot) continue;
    if (abs.startsWith(path.join(outRoot, '.pi') + path.sep)) continue; // never stash run machinery
    const st = await fs.stat(abs).catch(() => null);
    if (!st) continue;
    const relInRun = path.relative(outRoot, abs);
    const dest = path.join(stashDir, relInRun);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(abs, dest);
    } catch {
      // cross-device fallback — copy then remove.
      await fs.cp(abs, dest, { recursive: true });
      await fs.rm(abs, { recursive: true, force: true });
    }
    stashed.push(relInRun);
  }
  return stashed.length ? { stashDir, stashed } : null;
}

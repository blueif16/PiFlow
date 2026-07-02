// @piflow/core/observe — scope: resolve the LAUNCHED PROJECT'S product roots from a cwd, and build a registry
// scoped to them. This is the shared spine behind "a view shows the project you launched it in, not the whole
// accumulated global registry": `piflowctl gui` and `piflowctl tui` resolve the scope and pass it to their
// (spawned) app via `PIFLOW_SCOPE_ROOTS`; the in-process TUI resolves it from its own cwd. All three then read
// the SAME `loadScopedRegistry`, so no view re-derives discovery.
//
// A "product" is a dir whose `.piflow/` holds a REAL workflow (`<wf>/template/meta.json` or a `<wf>/runs/` dir)
// — NOT a bare `.piflow`. That distinction is load-bearing: the GLOBAL home `~/.piflow` (products.json /
// index.json / agents/) is itself a `.piflow` at $HOME, and a naive "has a .piflow" test mis-registers $HOME as
// a project (how `/Users/<me>` leaked into the registry). The workflow check excludes the home cleanly.

import fssync from 'node:fs';
import path from 'node:path';
import { loadRegistry, upsertRoot, type Registry } from './registry.js';

/** Dir names never worth descending into when scanning for products (build output, deps, test fixtures). */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'tmp', '.tmp', 'fixtures', '__fixtures__']);

/**
 * Is `dir` a pi-flow PRODUCT — does its `.piflow/` hold at least one REAL workflow (`<wf>/template/meta.json`
 * or a `<wf>/runs/` dir)? This is the guard that separates a product's `.piflow` from the GLOBAL home `~/.piflow`
 * (whose entries are files — products.json/index.json — plus `agents/`, never a `<wf>/template|runs`).
 */
export function isProductRoot(dir: string): boolean {
  const wfRoot = path.join(dir, '.piflow');
  let entries;
  try {
    entries = fssync.readdirSync(wfRoot, { withFileTypes: true });
  } catch {
    return false; // no `.piflow/` here
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (fssync.existsSync(path.join(wfRoot, e.name, 'template', 'meta.json'))) return true;
    if (fssync.existsSync(path.join(wfRoot, e.name, 'runs'))) return true;
  }
  return false;
}

/** Nearest ancestor of `start` that is a pi-flow product (a real `.piflow/` OR an `out/<id>/.pi/run.json`). */
export function findProductRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (isProductRoot(dir)) return dir;
    const out = path.join(dir, 'out');
    if (fssync.existsSync(out)) {
      try {
        for (const e of fssync.readdirSync(out, { withFileTypes: true })) {
          if (e.isDirectory() && fssync.existsSync(path.join(out, e.name, '.pi', 'run.json'))) return dir;
        }
      } catch { /* unreadable → keep walking */ }
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The canonical run layout DERIVED from a template's OWN location. Given a
 * `<product>/.piflow/<wf>/template` dir, return the product root (= `{{WORKSPACE}}`) and the runs
 * home (`<wf>/runs`, the `{{RUN}}` parent). PURE path logic (no fs) — the template's PLACEMENT is
 * the contract, so a run roots itself off the template it runs, NEVER off `process.cwd()`. Returns
 * `null` when `templateDir` is not on that D9 path (a loose template); the caller then falls back to
 * `findProductRoot` and WARNS rather than silently rooting at cwd.
 */
export function templateLayout(templateDir: string): { productRoot: string; runsHome: string } | null {
  const dir = path.resolve(templateDir);
  if (path.basename(dir) !== 'template') return null;
  const wfDir = path.dirname(dir); // `<product>/.piflow/<wf>`
  if (path.basename(path.dirname(wfDir)) !== '.piflow') return null; // not on the D9 path → loose template
  return { productRoot: path.dirname(path.dirname(wfDir)), runsHome: path.join(wfDir, 'runs') };
}

/**
 * Every product root AT or UNDER `start` — a recursive, depth-bounded walk that skips deps/build/fixtures and
 * every dot-dir (so `.git`, `.claude/worktrees/*`, and the `.piflow` dir itself are never descended into). The
 * start dir is always tested (even if named like a skip dir). Roots are absolute + sorted (stable order).
 */
export function findProductRootsUnder(start: string, maxDepth = 6): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = fssync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    if (isProductRoot(dir) && !seen.has(dir)) {
      seen.add(dir);
      roots.push(dir);
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue; // .piflow, .git, .claude, …
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(path.resolve(start), 0);
  return roots.sort();
}

/**
 * The display scope for a launch `cwd`: the enclosing project (walk up to the nearest real `.piflow/`) OR, when
 * launched outside any project, `cwd` itself — then EVERY product at/under that scope root. So from a subfolder
 * deep inside project P you get P (and P's nested sub-products); from a parent of many projects you get all of
 * them. Empty `roots` ⇒ nothing product-shaped in scope (the caller falls back to the global view).
 */
export function resolveScope(cwd: string): { scopeRoot: string; roots: string[] } {
  const enclosing = findProductRoot(cwd);
  const scopeRoot = enclosing ?? path.resolve(cwd);
  return { scopeRoot, roots: findProductRootsUnder(scopeRoot) };
}

/** An EPHEMERAL registry built from explicit roots (never reads or writes the global `~/.piflow/products.json`). */
export function registryFromRoots(roots: string[]): Registry {
  const registry: Registry = { products: [] };
  for (const r of roots) {
    const root = r.trim();
    if (root) upsertRoot(registry, root);
  }
  return registry;
}

/**
 * The registry a VIEW should serve, SCOPED to the launched project. Precedence:
 *   1) `PIFLOW_SCOPE_ROOTS` env (a `path.delimiter`-joined list) — the SPAWNED-process channel. `piflowctl gui`
 *      and `piflowctl tui` resolve the scope and set this for the child, because the child's own cwd is the app
 *      dir (gui/ or tui/), not the user's project.
 *   2) `resolveScope(cwd)` when a `cwd` is given — the IN-PROCESS channel (the TUI runs in the user's cwd, so it
 *      self-scopes with no env plumbing).
 *   3) the global `~/.piflow` registry (`loadRegistry`) — the fleet-wide fallback.
 * Building an ephemeral registry NEVER mutates the on-disk global registry, so a view never accumulates roots.
 */
export function loadScopedRegistry(cwd?: string): Registry {
  const env = process.env.PIFLOW_SCOPE_ROOTS;
  if (env && env.trim()) return registryFromRoots(env.split(path.delimiter));
  if (cwd) {
    const { roots } = resolveScope(cwd);
    if (roots.length) return registryFromRoots(roots);
  }
  return loadRegistry();
}

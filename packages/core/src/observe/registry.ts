// @piflow/core/observe — registry: the GLOBAL product registry (`~/.piflow/products.json`).
//
// The product-AGNOSTIC half of the fleet-observe surface: a list of REGISTERED repo ROOTS (paths only —
// NEVER any product's collected data) under the global home `~/.piflow/`, the analogue of the pi runtime's
// `~/.pi/`. This is the SAME registry the GUI middleware reads, the TUI's fleet picker reads, and
// `piflowctl run` self-registers into — so the CLI, the TUI, and the GUI are all exposed to the EXACT same set
// of repos. It writes ONLY under `~/.piflow/` (the architectural law: a global mapping/index lives there,
// never inside packages/ or a repo). It stores only POINTERS (roots), never a product's data — consistent
// with "the SDK is logic only".
//
// `~/.piflow` is overridable via `PIFLOW_HOME` (the unit-test seam + a relocate lever), mirroring how the
// rest of core reaches its globals (loadFusionConfig / loadModelTiers / defaultAgentsDir under this home).

import fssync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_TIERS_SEED, writeModelTiers } from '../runner/model-routing.js';

/** One registered product: a repo ROOT (paths only — no collected data ever lives here). */
export interface ProductEntry {
  id: string;
  name: string;
  root: string;
  registeredAt?: string;
}

/** The registry file body — the list of registered repo roots. */
export interface Registry {
  products: ProductEntry[];
}

/** The global home `~/.piflow` (override with `PIFLOW_HOME` — test seam + relocate lever). */
export function globalDir(): string {
  return process.env.PIFLOW_HOME ?? path.join(os.homedir(), '.piflow');
}

/** `~/.piflow/products.json` — the registered-repos registry. */
export function productsFile(): string {
  return path.join(globalDir(), 'products.json');
}

/** `~/.piflow/model-tiers.json` UNDER the global home (honors `PIFLOW_HOME`; unlike `defaultTiersPath`,
 * which is pinned to `~/.piflow` for the SDK read path). The lazy bootstrap seeds THIS path. */
export function homeTiersFile(): string {
  return path.join(globalDir(), 'model-tiers.json');
}

/**
 * The LAZY first-run bootstrap of `~/.piflow` (the user's "check on first run" design). Idempotent + cheap:
 * `mkdir -p` the home, then SEED `model-tiers.json` with the three canonical keys (`fast`/`balanced`/`deep`)
 * present and `active:false` — so `piflowctl model list` always has something to show and a node that pins a
 * `tier` gets the EXISTING clear "set a model / set active:true" routing error until configured.
 *
 * NEVER clobbers a user's values: if the tiers file already exists this is a pure NO-OP (the existsSync
 * guard). Honors `PIFLOW_HOME` (the test seam) by writing under `globalDir()`/`homeTiersFile()`, NOT the
 * `~/.piflow`-pinned `defaultTiersPath()`. Best-effort — a write failure (no permissions) is swallowed so it
 * can run unconditionally at the top of the CLI entry without ever failing a command.
 */
export function ensurePiflowHome(): void {
  try {
    fssync.mkdirSync(globalDir(), { recursive: true });
    const tiers = homeTiersFile();
    if (!fssync.existsSync(tiers)) writeModelTiers(DEFAULT_TIERS_SEED, tiers);
  } catch {
    /* best-effort: a non-writable home must never fail the command that triggered the bootstrap */
  }
}

/** `~/.piflow/index.json` — the periodic on-disk snapshot artifact (the live GUI recomputes; this caches). */
export function indexFile(): string {
  return path.join(globalDir(), 'index.json');
}

/** Read the registry, tolerating an absent/corrupt file (→ empty). NEVER throws. */
export function loadRegistry(): Registry {
  let registry: Registry = { products: [] };
  const file = productsFile();
  if (fssync.existsSync(file)) {
    try {
      registry = JSON.parse(fssync.readFileSync(file, 'utf8')) as Registry;
    } catch {
      registry = { products: [] };
    }
  }
  if (!Array.isArray(registry.products)) registry.products = [];
  return registry;
}

/**
 * True when `root` resolves — by REALPATH — under the OS temp dir: a test's `mkdtemp` scratch dir, a
 * throwaway sandbox workdir, or any other transient location no repo actually lives at. Compared via
 * `realpathSync` (falling back to the raw resolved path when a side doesn't exist) because on macOS
 * `os.tmpdir()` is ITSELF a `/var` symlink to `/private/var` — a raw prefix compare on the two raw paths
 * would silently never match, which is exactly how a test suite that ran a workflow without setting
 * `PIFLOW_HOME` (e.g. `packages/server/test/http-replay-e2e.test.ts`) leaked ~290 temp-dir corpses into the
 * REAL `~/.piflow/products.json` over time — this is the guard that stops that leak at the source.
 */
function isUnderTmpdir(root: string): boolean {
  const real = (p: string): string => {
    try {
      return fssync.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(os.tmpdir()), real(root));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Idempotent upsert of a repo root (matched by abs root OR basename id; refreshes a moved/renamed dir). */
export function upsertRoot(registry: Registry, root: string): Registry {
  const abs = path.resolve(root);
  const id = path.basename(abs);
  if (!Array.isArray(registry.products)) registry.products = [];
  const existing = registry.products.find((p) => p.root === abs || p.id === id);
  if (existing) {
    existing.id = id;
    existing.name = id;
    existing.root = abs;
  } else {
    registry.products.push({ id, name: id, root: abs, registeredAt: new Date().toISOString() });
  }
  return registry;
}

/**
 * Persist the registry to `~/.piflow/products.json` (mkdir -p the home first; pretty-printed).
 *
 * SELF-HEALING: before writing, drops any entry whose `root` no longer exists on disk (a deleted or moved
 * repo). Nothing ever pruned the registry file before, so a dead entry was a permanent corpse — this makes
 * every save an opportunity to quietly heal it, never resurrecting the ~290-corpse problem a leaky test
 * suite once caused (see `isUnderTmpdir` — the write-side guard that stops the leak at the source).
 */
export async function saveRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(globalDir(), { recursive: true });
  const pruned: Registry = { products: registry.products.filter((p) => fssync.existsSync(p.root)) };
  await fs.writeFile(productsFile(), JSON.stringify(pruned, null, 2) + '\n');
}

/**
 * SELF-REGISTER a repo root into the global registry: load → upsert → save. Called once at run-start
 * (`runFromTemplate`) so EVERY run, from ANY entry path, makes its repo visible to every observer (CLI /
 * TUI / GUI) with zero manual `--root`. The write-side analogue of the pi runtime self-registering each run
 * home into `~/.pi`. Returns the saved registry. The caller wraps this so index bookkeeping can never fail
 * a run.
 *
 * NO-OP for a root under `os.tmpdir()` (returns the loaded registry UNCHANGED, no upsert, no write) — a
 * test suite that runs a workflow without pointing `PIFLOW_HOME` at a scratch dir must never self-register
 * its temp workdir into the REAL global registry (the confirmed leak: packages/server/test/
 * http-replay-e2e.test.ts, ~290 entries over time).
 */
export async function registerProductRoot(root: string): Promise<Registry> {
  const registry = loadRegistry();
  if (isUnderTmpdir(root)) return registry;
  const updated = upsertRoot(registry, root);
  await saveRegistry(updated);
  return updated;
}

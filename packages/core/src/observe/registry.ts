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

/** Persist the registry to `~/.piflow/products.json` (mkdir -p the home first; pretty-printed). */
export async function saveRegistry(registry: Registry): Promise<void> {
  await fs.mkdir(globalDir(), { recursive: true });
  await fs.writeFile(productsFile(), JSON.stringify(registry, null, 2) + '\n');
}

/**
 * SELF-REGISTER a repo root into the global registry: load → upsert → save. Called once at run-start
 * (`runFromTemplate`) so EVERY run, from ANY entry path, makes its repo visible to every observer (CLI /
 * TUI / GUI) with zero manual `--root`. The write-side analogue of the pi runtime self-registering each run
 * home into `~/.pi`. Returns the saved registry. The caller wraps this so index bookkeeping can never fail
 * a run.
 */
export async function registerProductRoot(root: string): Promise<Registry> {
  const registry = upsertRoot(loadRegistry(), root);
  await saveRegistry(registry);
  return registry;
}

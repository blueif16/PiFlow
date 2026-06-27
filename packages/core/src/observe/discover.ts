// @piflow/core/observe — discover: the FLEET tier of the observe surface. Discover every workflow + run
// across the REGISTERED repos and fold them into ONE snapshot the CLI, the TUI, and the GUI all render.
//
// This is the per-FLEET counterpart to the per-RUN readers (`readRunModel` / `buildRunView`): where those
// take an OPAQUE run dir, this layer knows the SDK's §D9 CANONICAL run home — `<repo>/.piflow/<wf>/runs/<id>`
// — and walks it. (The per-run layout helpers stay convention-agnostic; only this explicit fleet layer
// encodes the canonical home, the SAME default `instantiateRun` materializes into.) `summarizeRun` stays an
// OPAQUE-dir reader producing ONE shared THREAD-ROW shape for every view — retiring the divergent GUI/TUI
// row builders that drifted (the GUI's `summarizeRun` import was even silently broken).
//
// PURE reads only: it READS each repo's run data and aggregates SUMMARIES + POINTERS into the snapshot — it
// NEVER copies a product's collected data anywhere (the data boundary). Both the live GUI middleware (per
// request) and `piflowctl run` / `build-index` consume this one builder, so they can never diverge.

import fssync from 'node:fs';
import path from 'node:path';
import { readRunModel } from './read.js';
import { buildRunView } from './runView.js';
import { runJsonFile } from '../runner/layout.js';
import type { Registry } from './registry.js';

/** The terminal-OK statuses a thread row counts as "done" (mirrors the observe status ladder). */
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);

/** A workflow's template meta (the fields a view reads; the rest of `meta.json` rides along untyped). */
export type NamespaceMeta = {
  id?: string;
  name?: string;
  description?: string;
  phases?: string[];
} & Record<string, unknown>;

/** One workflow (namespace) authored under a repo: its template meta + where it lives. */
export interface NamespaceDesc {
  id: string;
  name: string;
  templatePath: string;
  meta: NamespaceMeta;
}

/** One run summarized into the shared thread-row shape every view (CLI/TUI/GUI) iterates. */
export interface ThreadRow {
  run: string;
  runDir: string;
  statusPath: string;
  state: 'running' | 'done' | 'failed';
  done: boolean;
  ok: boolean | null;
  stageIndex: number | null;
  stageTotal: number | null;
  phase: string | null;
  runningNode: string | null;
  runningTool: string | null;
  runningStalled: boolean;
  nodesDone: number;
  nodesTotal: number;
  frac: number;
  elapsedMs: number | null;
  tokensBillable: number;
  cost: number;
  provider: string | null;
  model: string | null;
  updatedAt: string | null;
  staleMs: number | null;
  errorNode: string | null;
}

/** One namespace in a snapshot — a workflow (or the catch-all `unfiled`) with its run threads. */
export interface SnapshotNamespace {
  id: string;
  name: string;
  templatePath: string | null;
  meta: NamespaceMeta | null;
  threads: ThreadRow[];
}

/** One registered product (repo) in a snapshot, with its discovered namespaces. */
export interface SnapshotProduct {
  id: string;
  name: string;
  root: string;
  namespaces: SnapshotNamespace[];
}

/** The unified fleet snapshot — products → namespaces(workflows) → threads(runs). */
export interface Snapshot {
  generatedAt: string;
  products: SnapshotProduct[];
}

/** Workflows (namespaces) authored under `<root>/.piflow/<wf>/template/meta.json` (§D9 canonical home). */
export function discoverNamespaces(root: string): NamespaceDesc[] {
  const wfRoot = path.join(root, '.piflow');
  const out: NamespaceDesc[] = [];
  if (!fssync.existsSync(wfRoot)) return out;
  for (const entry of fssync.readdirSync(wfRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templatePath = path.join(wfRoot, entry.name, 'template', 'meta.json');
    if (!fssync.existsSync(templatePath)) continue;
    let meta: NamespaceMeta;
    try {
      meta = JSON.parse(fssync.readFileSync(templatePath, 'utf8')) as NamespaceMeta;
    } catch {
      continue;
    }
    out.push({ id: meta.id || entry.name, name: meta.name || meta.id || entry.name, templatePath, meta });
  }
  return out;
}

/**
 * Run dirs = ONLY the §D9 canonical home `<root>/.piflow/<wf>/runs/<id>` that hold a `.pi/run.json`. We do
 * NOT scan `out/<id>` (a build-output dir that merely colocates a `.pi/`) nor any committed GUI copy — real
 * runs live in their canonical home and are distilled live. A run dir WITHOUT `.pi/run.json` is SKIPPED
 * (no `RunStatus` was ever written — e.g. an aborted/pure-dry run): the snapshot shows only real runs.
 */
export function discoverRunDirs(root: string): { runDirs: string[]; searchRoots: string[] } {
  const wfRoot = path.join(root, '.piflow');
  const searchRoots = [wfRoot];
  const runDirs: string[] = [];
  const pushIfRun = (dir: string) => {
    if (fssync.existsSync(path.join(dir, '.pi', 'run.json'))) runDirs.push(dir);
  };
  const eachChildDir = (parent: string, fn: (d: string) => void) => {
    if (!fssync.existsSync(parent)) return;
    for (const e of fssync.readdirSync(parent, { withFileTypes: true })) if (e.isDirectory()) fn(path.join(parent, e.name));
  };
  eachChildDir(wfRoot, (wfDir) => eachChildDir(path.join(wfDir, 'runs'), pushIfRun));
  return { runDirs, searchRoots };
}

/** Associate a run to its namespace via `run.json.source` (basename, strip `-vX.Y` + `.js`); else `unfiled`. */
function namespaceIdForSource(source: string | null | undefined, namespaceIds: Set<string>): string {
  if (typeof source !== 'string' || !source) return 'unfiled';
  const base = path.basename(source).replace(/\.js$/i, '').replace(/-v\d+(\.\d+)*$/i, '');
  return namespaceIds.has(base) ? base : 'unfiled';
}

/** Read a run dir's `run.json.source` (the workflow it ran), or null. */
function readRunSource(runDir: string): string | null {
  try {
    return (JSON.parse(fssync.readFileSync(runJsonFile(runDir), 'utf8')).source ?? null) as string | null;
  } catch {
    return null;
  }
}

/**
 * Summarize an OPAQUE run dir → the shared thread row (the ONE row shape every view renders). Structure /
 * status come from the lean `readRunModel`; the billable-tokens + cost rollup from the rich `buildRunView`
 * (0 when no events exist). Returns null when there is no readable run (no `.pi/run.json`).
 */
export async function summarizeRun(runDir: string): Promise<ThreadRow | null> {
  let m;
  try {
    m = await readRunModel(runDir);
  } catch {
    return null;
  }
  const nodes = m.nodes;
  const nodesDone = nodes.filter((n) => TERMINAL_OK.has(n.status)).length;
  const running = nodes.find((n) => n.status === 'running');
  const errored = nodes.find((n) => n.status === 'error' || n.status === 'blocked');
  let tokensBillable = 0;
  let cost = 0;
  try {
    const tt = buildRunView(runDir).view.tokenTotal;
    if (tt) {
      tokensBillable = tt.billable || 0;
      cost = tt.cost || 0;
    }
  } catch {
    /* no rich view (run carries no events) — tokens/cost null-render as 0 */
  }
  return {
    run: m.run,
    runDir: path.resolve(runDir),
    statusPath: path.resolve(runDir),
    state: m.done ? (m.ok === false ? 'failed' : 'done') : 'running',
    done: !!m.done,
    ok: m.ok ?? null,
    stageIndex: m.stage?.index ?? null,
    stageTotal: m.stage?.total ?? null,
    phase: null,
    runningNode: running?.id ?? null,
    runningTool: null,
    runningStalled: false,
    nodesDone,
    nodesTotal: nodes.length,
    frac: m.done ? 1 : nodes.length ? nodesDone / nodes.length : 0,
    // A finished run carries its final durationMs; a RUNNING one has none yet, so show elapsed-so-far
    // (now − startedAt) — this is a live snapshot, so the fleet/GUI chip can render a running run's clock.
    // The live fallback is gated on !done so a done-but-durationless record reads "—", not a bogus now−start.
    elapsedMs: m.durationMs ?? (!m.done && m.startedAt ? Math.max(0, Date.now() - Date.parse(m.startedAt)) : null),
    tokensBillable,
    cost,
    provider: m.provider ?? null,
    model: m.model ?? null,
    updatedAt: null,
    staleMs: null,
    errorNode: errored?.id ?? null,
  };
}

/**
 * Build the unified fleet snapshot from a registry — `{ generatedAt, products:[{ id,name,root,namespaces }] }`.
 * PURE (no writes, no `process.exit`). A run associates to its workflow by `run.json.source`, and that
 * workflow's template can live in a DIFFERENT registered product than the run — so source is resolved
 * against ALL products' templates (not just the run's own), filing such runs under their REAL namespace
 * (with its template/meta) instead of falling to `unfiled`. Per-run reads are a few stats, so recomputing
 * this per request (the live GUI) is cheap for a normal fleet.
 */
export async function buildSnapshot(registry: Registry): Promise<Snapshot> {
  const globalNs = new Map<string, NamespaceDesc>();
  for (const p of registry.products)
    for (const ns of discoverNamespaces(p.root)) if (!globalNs.has(ns.id)) globalNs.set(ns.id, ns);
  const globalNsIds = new Set(globalNs.keys());

  const products: SnapshotProduct[] = [];
  for (const product of registry.products) {
    const root = product.root;
    const namespaces = discoverNamespaces(root);
    const { runDirs } = discoverRunDirs(root);
    const nsById = new Map<string, SnapshotNamespace>(
      namespaces.map((ns) => [ns.id, { id: ns.id, name: ns.name, templatePath: ns.templatePath, meta: ns.meta, threads: [] }]),
    );

    for (const runDir of runDirs) {
      const thread = await summarizeRun(runDir);
      if (!thread) continue;
      const nsId = namespaceIdForSource(readRunSource(runDir), globalNsIds);
      if (!nsById.has(nsId)) {
        const g = globalNs.get(nsId);
        nsById.set(
          nsId,
          g
            ? { id: g.id, name: g.name, templatePath: g.templatePath, meta: g.meta, threads: [] }
            : { id: nsId, name: nsId, templatePath: null, meta: null, threads: [] },
        );
      }
      nsById.get(nsId)!.threads.push(thread);
    }

    const orderedNs = namespaces.map((ns) => ns.id);
    for (const id of nsById.keys()) if (!orderedNs.includes(id)) orderedNs.push(id);
    const productNamespaces = orderedNs.map((id) => nsById.get(id)!);
    products.push({ id: product.id, name: product.name, root, namespaces: productNamespaces });
  }
  return { generatedAt: new Date().toISOString(), products };
}

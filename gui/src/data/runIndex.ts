// runIndex.ts — the GUI's view of the GLOBAL piflow index (the snapshot generated
// into ~/.piflow/index.json by gui/scripts/build-index.mjs and served by the Vite
// middleware at /__piflow/index.json). The shape mirrors the generator's output:
// products → namespaces(workspaces) → threads(runs). Thread fields mirror the TUI's
// `summarizeRun` row so TUI + GUI agree. Real data only; no mock fallback.
import type { DirEntry } from "../components/DirectoryPanel";
import { apiFetch } from "./apiBase";

/** One run, as summarized into the global index (mirrors summarizeRun + pointer fields). */
export interface IndexThread {
  run: string;
  runDir: string;
  state: string; // running | done | failed
  done: boolean;
  ok: boolean | null;
  stageIndex: number | null;
  stageTotal: number | null;
  phase: string | null;
  runningNode: string | null;
  /** the in-flight tool of the running node (from its events); null when no running node or no open tool call. */
  runningTool: string | null;
  /** ms since the run last wrote status (now − updatedAt) for a running run; null otherwise. */
  staleMs: number | null;
  /** true when a running run has been silent past the shared stale threshold (staleMs > ~90s). */
  runningStalled: boolean;
  nodesDone: number;
  nodesTotal: number;
  frac: number;
  elapsedMs: number | null;
  /** wall-clock of the last status write (ISO) — recency sort key for pickCurrentRun; null when unknown. */
  updatedAt: string | null;
  provider: string | null;
  model: string | null;
  errorNode: string | null;
  /** GUI-fetchable path (runs/<run>/run-view.json) when the run lives under gui/public. */
  runViewPath: string;
  /** false when the run isn't served by this GUI (e.g. lives under another product's dir). */
  viewable: boolean;
}

export interface IndexNamespace {
  id: string;
  name: string;
  meta?: { id: string; name: string; description?: string; phases?: string[] };
  /** the workflow's `template/meta.json` path, when it's authored on disk — present even with ZERO runs
   *  (core's `discoverNamespaces` resolves it straight from the template, independent of any run). Drives
   *  the pinned "Template" row in the switcher. Null for a template-less namespace (runs-only, legacy). */
  templatePath?: string | null;
  threads: IndexThread[];
}

export interface IndexProduct {
  id: string;
  name: string;
  root: string;
  namespaces: IndexNamespace[];
}

export interface GlobalIndex {
  generatedAt: string;
  products: IndexProduct[];
}

/** Fetch the global snapshot from the Vite middleware (source of truth: ~/.piflow/index.json). */
export async function loadIndex(): Promise<GlobalIndex> {
  const res = await apiFetch("/__piflow/index.json");
  if (!res.ok) throw new Error(`global index unavailable (${res.status}) — run \`npm run data:index\``);
  return (await res.json()) as GlobalIndex;
}

/** A thread plus the names that locate it, for the menu-bar status chip. */
export interface ActiveThread extends IndexThread {
  productName: string;
  nsId: string;
  nsName: string;
}

/** Find a run's thread row (and the namespace/product it lives under) by run id. */
export function findThread(ix: GlobalIndex, run: string): ActiveThread | null {
  for (const p of ix.products)
    for (const ns of p.namespaces)
      for (const t of ns.threads)
        if (t.run === run) return { ...t, productName: p.name, nsId: ns.id, nsName: ns.name };
  return null;
}

/** The focus-run ranking, shared by the global picker and the per-workspace picker: a `running` run wins
 *  (follow what's happening NOW); else the most recently updated; else the last discovered. Null when empty. */
function pickRunFromThreads(threads: IndexThread[]): string | null {
  if (!threads.length) return null;
  const running = threads.find((t) => t.state === "running");
  if (running) return running.run;
  const dated = threads.filter((t) => t.updatedAt).sort((a, b) => (a.updatedAt! < b.updatedAt! ? 1 : -1));
  return (dated[0] ?? threads[threads.length - 1]).run;
}

/**
 * Pick the run to focus on first: a `running` run wins (follow what's happening NOW); else the most
 * recently updated; else the last discovered. Returns null for an empty index. This is what replaces
 * the hardcoded demo default — the GUI opens on the real current run.
 */
export function pickCurrentRun(ix: GlobalIndex): string | null {
  const threads: IndexThread[] = [];
  for (const p of ix.products) for (const ns of p.namespaces) for (const t of ns.threads) threads.push(t);
  return pickRunFromThreads(threads);
}

// ── Workspace (= product / folder) projection — the switch-workspace launcher's data ──────────────────────
// A "workspace" in the UI is a `product` (a folder/repo). The launcher lists these; entering one re-scopes
// the console to that folder's runs (+ its live pi session). These selectors are PURE — unit-tested, no I/O.

/** One workspace (product/folder) summarized for the launcher grid. */
export interface WorkspaceCard {
  id: string;
  name: string;
  root: string;
  /** number of templates (namespaces) authored in this folder. */
  templateCount: number;
  /** number of runs (threads) across all its templates. */
  runCount: number;
  /** how many of those runs are currently `running` (drives the live dot). */
  runningCount: number;
  /** the most recent thread `updatedAt` in the folder (recency sort key); null when it has no dated runs. */
  lastUpdatedAt: string | null;
  /** true when at least one run here is openable by this serve (else the folder is listed but not yet enterable). */
  viewable: boolean;
}

/**
 * Project the index into workspace cards, ordered the way a launcher should lead: folders with a LIVE run
 * first, then most-recently-active, then alphabetical — i.e. "recents first". Pure.
 */
export function deriveWorkspaces(ix: GlobalIndex): WorkspaceCard[] {
  const cards: WorkspaceCard[] = ix.products.map((p) => {
    const threads = p.namespaces.flatMap((ns) => ns.threads);
    const dated = threads.map((t) => t.updatedAt).filter((u): u is string => !!u).sort();
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      templateCount: p.namespaces.length,
      runCount: threads.length,
      runningCount: threads.filter((t) => t.state === "running").length,
      lastUpdatedAt: dated.length ? dated[dated.length - 1] : null,
      viewable: threads.some((t) => t.viewable),
    };
  });
  return cards.sort((a, b) => {
    if ((b.runningCount > 0 ? 1 : 0) !== (a.runningCount > 0 ? 1 : 0)) return (b.runningCount > 0 ? 1 : 0) - (a.runningCount > 0 ? 1 : 0);
    if (a.lastUpdatedAt !== b.lastUpdatedAt) return (b.lastUpdatedAt ?? "") < (a.lastUpdatedAt ?? "") ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** The product id (workspace) that owns a run, or null if the run isn't in the index. */
export function workspaceOfRun(ix: GlobalIndex, run: string): string | null {
  for (const p of ix.products)
    for (const ns of p.namespaces)
      for (const t of ns.threads)
        if (t.run === run) return p.id;
  return null;
}

/** Pick the run to focus when ENTERING a workspace: its running run > its newest > its last. Null if empty. */
export function pickRunForWorkspace(ix: GlobalIndex, productId: string): string | null {
  const p = ix.products.find((x) => x.id === productId);
  if (!p) return null;
  return pickRunFromThreads(p.namespaces.flatMap((ns) => ns.threads));
}

/** Parse the launched "home" folder roots the CLI passes to the client (VITE_PIFLOW_HOME_ROOTS, newline-joined).
 *  Empty in raw dev / when unset — initial focus then falls back to the global running/newest run. */
export function homeRoots(): string[] {
  try {
    const raw = (import.meta.env.VITE_PIFLOW_HOME_ROOTS ?? "") as string;
    return raw ? raw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** The workspace (product id) whose folder is one of the launched home roots, or null. Biases initial focus to
 *  the folder `piflowctl gui` was launched in, even after the served scope is widened to every registered folder. */
export function homeWorkspace(ix: GlobalIndex, roots: string[]): string | null {
  if (!roots.length) return null;
  const norm = (p: string) => p.replace(/\/+$/, "");
  const set = new Set(roots.map(norm));
  const hit = ix.products.find((p) => set.has(norm(p.root)));
  return hit ? hit.id : null;
}

export interface SwitcherEntry { run: string; viewable: boolean; productId: string; nsId: string; kind: "run" | "template"; }

/** The switcher's run-leaf orderings. `time` is the default (what the panel opens on). */
export type ThreadSortMode = "time" | "name" | "status";

/** updatedAt DESC with null-updatedAt last — the recency tiebreaker shared by the non-name modes. */
function byUpdatedDesc(a: IndexThread, b: IndexThread): number {
  if (a.updatedAt && b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
  if (a.updatedAt) return -1; // a dated, b null → a first
  if (b.updatedAt) return 1; // b dated, a null → b first
  return 0;
}

/**
 * Sort a namespace's threads for the switcher — PURE (never mutates the input array):
 *   - `time`   (default): a `running` run always leads (newest first among running ties), then
 *                updatedAt desc, null updatedAt last.
 *   - `name`   : plain A–Z by run id, ignoring state and dates.
 *   - `status` : running → failed → done groups, newest first inside each group.
 */
export function sortThreads(threads: IndexThread[], mode: ThreadSortMode = "time"): IndexThread[] {
  const arr = [...threads];
  if (mode === "name") return arr.sort((a, b) => a.run.localeCompare(b.run));
  if (mode === "status") {
    const rank = (t: IndexThread) => (t.state === "running" ? 0 : t.state === "failed" ? 1 : 2);
    return arr.sort((a, b) => rank(a) - rank(b) || byUpdatedDesc(a, b));
  }
  const runningFirst = (t: IndexThread) => (t.state === "running" ? 0 : 1);
  return arr.sort((a, b) => runningFirst(a) - runningFirst(b) || byUpdatedDesc(a, b));
}

/**
 * Project the global index into the Miller-column tree the DirectoryPanel renders, SCOPED to one workspace
 * (`productId`) — the root column is ONLY that workspace's namespaces, never another workspace's (THE LAW:
 * a view scoped to a workspace shows ONLY that workspace's workflows). Falls back to EVERY product's
 * namespaces flattened to the root when `productId` is null/undefined or matches no registered workspace —
 * so the switcher is never empty just because a caller couldn't resolve a workspace. Each namespace's
 * threads are ordered by `sortThreads(threads, sort)` (default `time` — never the discovery order
 * `buildSnapshot` returns) and, when a namespace's display name differs from its directory id (an author's
 * `meta.name` can collide across dirs — the id never can), the dir id rides along as `secondaryLabel` so
 * DirectoryPanel can render it as a disambiguating mono tag. Each run leaf also carries the thread's
 * status fields VERBATIM (`run: { state, ok, frac, done, total }` — the GUI computes nothing) so the panel
 * can render its progress cluster. Returns a resolver from a leaf id → the run.
 */
export function indexToTree(
  ix: GlobalIndex,
  productId?: string | null,
  sort: ThreadSortMode = "time",
): { tree: DirEntry[]; resolve: (id: string) => SwitcherEntry | undefined } {
  const map = new Map<string, SwitcherEntry>();
  const tree: DirEntry[] = [];
  const scoped = productId ? ix.products.filter((p) => p.id === productId) : [];
  const products = scoped.length ? scoped : ix.products;
  for (const p of products) {
    for (const ns of p.namespaces) {
      const children: DirEntry[] = [];
      // The pinned "Template" row — the canonical workflow, no run needed. Always FIRST + `pinned` (the
      // panel divides it from the run rows below); present whenever the namespace has an authored template
      // on disk, even with zero runs (that's the whole point of pinning it).
      if (ns.templatePath) {
        const id = `tpl:${p.id}/${ns.id}`;
        map.set(id, { run: id, viewable: true, productId: p.id, nsId: ns.id, kind: "template" });
        children.push({ id, name: "Template", kind: "file", typeLabel: "template", pinned: true });
      }
      for (const t of sortThreads(ns.threads, sort)) {
        const id = `t:${p.id}/${ns.id}/${t.run}`;
        map.set(id, { run: t.run, viewable: t.viewable, productId: p.id, nsId: ns.id, kind: "run" });
        children.push({
          id,
          name: t.run,
          kind: "file",
          typeLabel: t.state,
          run: { state: t.state, ok: t.ok, frac: t.frac, done: t.nodesDone, total: t.nodesTotal },
        });
      }
      tree.push({
        id: `n:${p.id}/${ns.id}`,
        name: ns.name,
        kind: "folder",
        secondaryLabel: ns.name !== ns.id ? ns.id : undefined,
        children,
      });
    }
  }
  return { tree, resolve: (id) => map.get(id) };
}

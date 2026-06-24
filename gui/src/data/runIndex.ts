// runIndex.ts — the GUI's view of the GLOBAL piflow index (the snapshot generated
// into ~/.piflow/index.json by gui/scripts/build-index.mjs and served by the Vite
// middleware at /__piflow/index.json). The shape mirrors the generator's output:
// products → namespaces(workspaces) → threads(runs). Thread fields mirror the TUI's
// `summarizeRun` row so TUI + GUI agree. Real data only; no mock fallback.
import type { DirEntry } from "../components/DirectoryPanel";

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
  const res = await fetch("/__piflow/index.json");
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

/**
 * Pick the run to focus on first: a `running` run wins (follow what's happening NOW); else the most
 * recently updated; else the last discovered. Returns null for an empty index. This is what replaces
 * the hardcoded demo default — the GUI opens on the real current run.
 */
export function pickCurrentRun(ix: GlobalIndex): string | null {
  const threads: IndexThread[] = [];
  for (const p of ix.products) for (const ns of p.namespaces) for (const t of ns.threads) threads.push(t);
  if (!threads.length) return null;
  const running = threads.find((t) => t.state === "running");
  if (running) return running.run;
  const dated = threads.filter((t) => t.updatedAt).sort((a, b) => (a.updatedAt! < b.updatedAt! ? 1 : -1));
  return (dated[0] ?? threads[threads.length - 1]).run;
}

export interface SwitcherEntry { run: string; viewable: boolean; productId: string; nsId: string; }

/**
 * Project the global index into the Miller-column tree the DirectoryPanel renders.
 * Root level = WORKSPACES (namespaces) directly — the product (e.g. "piflow") is
 * NOT a column; workspaces from every product are flattened to the root, then each
 * opens its run leaves. Returns a resolver from a leaf id → the run.
 */
export function indexToTree(ix: GlobalIndex): { tree: DirEntry[]; resolve: (id: string) => SwitcherEntry | undefined } {
  const map = new Map<string, SwitcherEntry>();
  const tree: DirEntry[] = [];
  for (const p of ix.products) {
    for (const ns of p.namespaces) {
      tree.push({
        id: `n:${p.id}/${ns.id}`,
        name: ns.name,
        kind: "folder",
        children: ns.threads.map((t) => {
          const id = `t:${p.id}/${ns.id}/${t.run}`;
          map.set(id, { run: t.run, viewable: t.viewable, productId: p.id, nsId: ns.id });
          return { id, name: t.run, kind: "file" as const, typeLabel: t.state };
        }),
      });
    }
  }
  return { tree, resolve: (id) => map.get(id) };
}

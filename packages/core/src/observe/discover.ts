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
import { nodeEventsFile } from '../runner/layout.js';
import type { Registry } from './registry.js';
import type { RunStatus } from '../runner/status.js';

/** The terminal-OK statuses a thread row counts as "done" (mirrors the observe status ladder). */
const TERMINAL_OK = new Set(['ok', 'reused', 'gap', 'dry']);

/**
 * A running thread whose `.pi/run.json` last updated more than this long ago counts as STALLED. ONE
 * named threshold so the producer (`runningStalled`) and every consumer agree — the TUI's ThreadCol
 * stale highlight (`tui/components.mjs`: `t.staleMs > 90000`) reads against this same 90s bar.
 */
export const STALE_MS_THRESHOLD = 90_000;

/**
 * The tool the running node is CURRENTLY executing, derived robustly from its `events.jsonl`: the LAST
 * `tool_execution_start` whose `toolCallId` never saw a matching `tool_execution_end` (an in-flight call).
 * Re-read here (a single file, the one running node) because `buildRunView` FLATTENS in-flight spans into
 * its timeline as `durMs:0` entries indistinguishable from genuinely-instant completed tools — its private
 * `open` map (the only robust in-flight signal) is closed+cleared in `finalize`, so the computed run-view
 * cannot expose "the current tool". Returns null when the file is absent, holds no open call, or is torn.
 */
function runningToolOf(runDir: string, nodeId: string): string | null {
  const f = nodeEventsFile(runDir, nodeId);
  let raw: string;
  try {
    raw = fssync.readFileSync(f, 'utf8');
  } catch {
    return null; // no events archive (node emitted nothing / not started) — no in-flight tool to show
  }
  // toolCallId → toolName for every started-but-not-yet-ended call; insertion order = start order, so the
  // LAST surviving entry is the most-recently-started in-flight tool (the one the node is running now).
  const open = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev: { type?: unknown; toolName?: unknown; toolCallId?: unknown };
    try {
      ev = JSON.parse(s);
    } catch {
      continue; // a torn line never derails the scan
    }
    const id = typeof ev.toolCallId === 'string' ? ev.toolCallId : null;
    if (ev.type === 'tool_execution_start' && id) {
      open.set(id, typeof ev.toolName === 'string' ? ev.toolName : '');
    } else if (ev.type === 'tool_execution_end' && id) {
      open.delete(id);
    }
  }
  let last: string | null = null;
  for (const name of open.values()) last = name; // keep the last-inserted still-open call
  return last || null;
}

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
  /** the CANONICAL home's `template/meta.json` (the dir NAMED like the id when present, else the first
   *  discovered) — what a launcher (StartRunPanel) starts runs from. */
  templatePath: string;
  meta: NamespaceMeta;
  /** every `.piflow/` dir that is a home of this workflow (variant/experiment dirs sharing one meta.id). */
  dirs: string[];
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
  /** (M8 — child runs) The PARENT run's id, verbatim off `RunModel.parent` (itself verbatim off
   *  `RunStatus.parent`) — present only when this run was minted by `spawnChildRun` (optimize/substrate).
   *  Absent on a normal top-level run. Drives `groupByParent`'s nesting. */
  parent?: string;
  /** (M8 — child runs) WHO/WHY spawned this child run, verbatim off `RunModel.spawnedBy`. Absent on a normal
   *  top-level run (only ever set alongside `parent`). A viewer attributes the nesting via `spawnedBy.issue`. */
  spawnedBy?: RunStatus['spawnedBy'];
}

/** One namespace in a snapshot — a workflow (keyed by its `meta.id`, fallback dir name) with its run threads. */
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

/**
 * Workflows (namespaces) authored under `<root>/.piflow/<wf>/template/meta.json` (§D9 canonical home).
 *
 * IDENTITY LAW: `meta.id` IS the workflow's identity (fallback: the dir name when meta.json declares no
 * id). Several sibling dirs under one product's `.piflow/` may share one meta.id — game-omni's cObl/gLG/
 * gmB/gmC/gmD/game-omni are variant/experiment HOMES of the ONE workflow — and they MERGE into ONE
 * namespace, returned exactly once (`dirs` lists every home). The canonical `templatePath`/`meta` come
 * from the MAIN home — the dir whose NAME equals the meta.id — when present, else the first discovered
 * (this matters: a launcher starts runs off `templatePath`, so it must be the canonical template, not
 * whichever variant readdir happened to hit first). A dir whose meta.json is unparseable is skipped here
 * (nothing launchable to describe); its runs still surface in `buildSnapshot` under the dir name.
 */
export function discoverNamespaces(root: string): NamespaceDesc[] {
  const wfRoot = path.join(root, '.piflow');
  const out: NamespaceDesc[] = [];
  const byId = new Map<string, NamespaceDesc>();
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
    const id = typeof meta.id === 'string' && meta.id ? meta.id : entry.name;
    const existing = byId.get(id);
    if (existing) {
      existing.dirs.push(entry.name);
      if (entry.name === id) {
        // the MAIN home (dir named like the id) — its template/meta become the namespace's canonical ones
        existing.templatePath = templatePath;
        existing.meta = meta;
        existing.name = meta.name || id;
      }
    } else {
      const desc: NamespaceDesc = { id, name: meta.name || id, templatePath, meta, dirs: [entry.name] };
      byId.set(id, desc);
      out.push(desc);
    }
  }
  return out;
}

/**
 * The workflow DIRECTORY name a run belongs to, derived PURELY from its own canonical path — a run at
 * `<root>/.piflow/<wf>/runs/<id>` belongs to `<wf>` BY CONSTRUCTION (§D9). Never parses `run.json.source`
 * (that basename-matching approach cross-product-leaked: a source could coincidentally match ANOTHER
 * product's template and file the run under a namespace it never lived in). Returns `null` only when
 * `runDir` isn't shaped as the canonical home under `root` — defensive; `discoverRunDirs` never emits such
 * a path, since it discovers run dirs BY walking exactly this `.piflow/<wf>/runs/<id>` shape.
 */
function wfOfRunDir(root: string, runDir: string): string | null {
  const rel = path.relative(root, runDir).split(path.sep);
  if (rel.length < 4 || rel[0] !== '.piflow' || rel[2] !== 'runs') return null;
  return rel[1];
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

  // ── live, running-only fields (mirroring the `!m.done && …` gating of elapsedMs above) ──────────────
  // staleMs: how long since the run last wrote `.pi/run.json` (now − updatedAt) for a RUNNING run, when
  // updatedAt is a valid date. null for a done run, or when updatedAt is missing/unparseable. Clock-based,
  // matching the existing `elapsedMs` live-snapshot precedent (no new impurity beyond the Date.now() it uses).
  const updatedMs = m.updatedAt ? Date.parse(m.updatedAt) : NaN;
  const staleMs = !m.done && Number.isFinite(updatedMs) ? Math.max(0, Date.now() - updatedMs) : null;
  const runningStalled = staleMs != null && staleMs > STALE_MS_THRESHOLD;
  // phase: the current phase label for a running run — prefer the running node's phase; else the phase of
  // the first node in the engine's last-published barrier (`m.stage.nodeIds`); else null. A done run is null.
  const stageNode = m.stage?.nodeIds?.length
    ? nodes.find((n) => n.id === m.stage!.nodeIds[0])
    : undefined;
  const phase = m.done ? null : (running?.phase ?? stageNode?.phase ?? null);
  // runningTool: the in-flight tool of the running node, scanned from its events.jsonl (the only robust
  // in-flight source — see runningToolOf). null when there is no running node or no open tool call.
  const runningTool = running ? runningToolOf(runDir, running.id) : null;

  return {
    run: m.run,
    runDir: path.resolve(runDir),
    statusPath: path.resolve(runDir),
    state: m.done ? (m.ok === false ? 'failed' : 'done') : 'running',
    done: !!m.done,
    ok: m.ok ?? null,
    stageIndex: m.stage?.index ?? null,
    stageTotal: m.stage?.total ?? null,
    phase,
    runningNode: running?.id ?? null,
    runningTool,
    runningStalled,
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
    updatedAt: m.updatedAt ?? null,
    staleMs,
    errorNode: errored?.id ?? null,
    // (M8 — child runs) verbatim off the ALREADY-PARSED RunModel above — zero new I/O.
    parent: m.parent,
    spawnedBy: m.spawnedBy,
  };
}

/** One node in the parent→children forest `groupByParent` builds — a `ThreadRow` plus its nested children. */
export interface ThreadNode {
  thread: ThreadRow;
  children: ThreadNode[];
}

/**
 * PURE: nest child runs under their parent via `ThreadRow.parent` (an exact `run` id match), building a
 * forest the GUI run switcher renders in place of a flat list. A child whose declared `parent` is NOT among
 * `threads` (an ORPHAN — e.g. the parent run was pruned, or the caller passed a filtered subset) is promoted
 * to TOP-LEVEL rather than dropped — no run silently disappears from a view for want of its parent. Order is
 * DETERMINISTIC and stable: top-level rows keep the input array's order, and each parent's children keep the
 * input array's order too (this function never re-sorts by time/severity/etc. — a viewer sorts if it wants
 * to). Nesting recurses, so a grandchild (a child run itself re-spawned) nests under ITS parent in turn —
 * today's `spawnChildRun` only ever mints depth-1 children, but the fold does not assume that.
 */
export function groupByParent(threads: ThreadRow[]): ThreadNode[] {
  const byRun = new Set(threads.map((t) => t.run));
  const childrenOf = new Map<string, ThreadRow[]>();
  const roots: ThreadRow[] = [];
  for (const t of threads) {
    if (t.parent && byRun.has(t.parent)) {
      const list = childrenOf.get(t.parent);
      if (list) list.push(t);
      else childrenOf.set(t.parent, [t]);
    } else {
      roots.push(t); // no parent declared, or the parent isn't in this set (orphan) — top-level
    }
  }
  const build = (t: ThreadRow): ThreadNode => ({ thread: t, children: (childrenOf.get(t.run) ?? []).map(build) });
  return roots.map(build);
}

/**
 * Build the unified fleet snapshot from a registry — `{ generatedAt, products:[{ id,name,root,namespaces }] }`.
 * PURE (no writes, no `process.exit`). Per THE LAW (one product workspace = one `.piflow/`, scanned only at
 * that product's own root): every namespace and every run are discovered and filed WITHIN their own product's
 * `root` only — never across products, and never by parsing `run.json.source`. A run's namespace comes from
 * its PATH: the meta.id of the wf dir it physically lives in (`wfOfRunDir` → the dir's merged namespace),
 * falling back to the dir name for a template-less/unparseable home — there is no `unfiled` catch-all,
 * because a discovered run always has a parent wf dir by construction. Each namespace is emitted EXACTLY
 * ONCE: `discoverNamespaces` already merges every home of a shared meta.id into one NamespaceDesc, so
 * sibling variant dirs contribute their runs to the ONE workflow they belong to instead of repeating it.
 * Per-run reads are a few stats, so recomputing this per request (the live GUI) is cheap.
 */
export async function buildSnapshot(registry: Registry): Promise<Snapshot> {
  const products: SnapshotProduct[] = [];
  for (const product of registry.products) {
    const root = product.root;
    const namespaces = discoverNamespaces(root);
    const { runDirs } = discoverRunDirs(root);
    const nsById = new Map<string, SnapshotNamespace>(
      namespaces.map((ns) => [ns.id, { id: ns.id, name: ns.name, templatePath: ns.templatePath, meta: ns.meta, threads: [] }]),
    );
    // dir → namespace id: how a run's PATH resolves to its (possibly merged) workflow identity.
    const nsIdOfDir = new Map<string, string>();
    for (const ns of namespaces) for (const d of ns.dirs) nsIdOfDir.set(d, ns.id);

    for (const runDir of runDirs) {
      const thread = await summarizeRun(runDir);
      if (!thread) continue;
      const wf = wfOfRunDir(root, runDir);
      if (!wf) continue; // defensive only: discoverRunDirs never emits a path outside the canonical shape
      const nsId = nsIdOfDir.get(wf) ?? wf; // template-less/unparseable home → the dir name is the identity
      if (!nsById.has(nsId)) nsById.set(nsId, { id: nsId, name: nsId, templatePath: null, meta: null, threads: [] });
      nsById.get(nsId)!.threads.push(thread);
    }

    // `namespaces` ids are unique by construction (discoverNamespaces merges shared meta.ids into one
    // entry), so each namespace is emitted once; any wf discovered ONLY via its runs/ (template-less) is
    // appended after the templated ones.
    const orderedNs = namespaces.map((ns) => ns.id);
    for (const id of nsById.keys()) if (!orderedNs.includes(id)) orderedNs.push(id);
    const productNamespaces = orderedNs.map((id) => nsById.get(id)!);
    products.push({ id: product.id, name: product.name, root, namespaces: productNamespaces });
  }
  return { generatedAt: new Date().toISOString(), products };
}

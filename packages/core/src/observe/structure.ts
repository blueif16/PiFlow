// structure.ts — the ONE stage/edge resolver both readers share.
//
// The run's GRAPH — its topological stages (columns × parallel lanes) and its data-flow edges — is
// resolved by ONE priority ladder, so the lean live snapshot (`readRunModel`) and the enriched on-demand
// view (`buildRunView`) draw the SAME graph. Before this extraction they diverged: `buildRunView` PREFERS
// the run-local resolved DAG (`.pi/workflow.json`) while `readRunModel` reconstructed edges purely from the
// io ledgers — so the live graph and the loaded graph could show different edges/stages (the P0b gap).
//
// Priority (both stages AND edges use the SAME winner):
//   1. run-local RESOLVED DAG — `.pi/workflow.json` (the runner wrote it with the active profile already
//      applied: elided nodes dropped, deps rewired). AUTHORITATIVE — the graph the run actually executed.
//   2. declared TEMPLATE — `opts.workflow` (piflow init's `workflow.json`: ordered `stages` + per-node
//      `deps`), used only when it covers every present node (stages) / to fill missing links (edges).
//   3. phase grouping in EXECUTION ORDER — derived from the run alone (phase columns + runtime file-flow
//      edges from the declared io ledgers UNION the events-observed reads/writes).
//
// PURE over its inputs (it reads `.pi/workflow.json` off disk, nothing else). Returns the resolved stages,
// the resolved edges, AND the per-node {stageIndex, lane} placement so each caller stamps its own nodes.

import fssync from 'node:fs';
import path from 'node:path';

export interface ResolvedStage { index: number; phase: string | null; parallel: boolean; nodeIds: string[] }
export interface ResolvedEdge { from: string; to: string; path: string }

/** The per-node facts the resolver needs — present in BOTH readers (status record + io ledger + replay). */
export interface StructureNode {
  id: string;
  phase: string | null;
  /** ISO start (execution-order key for the phase-grouping fallback); missing ⇒ sorts first. */
  startedAt?: string;
  /** DECLARED io.json reads (paths as recorded — absolutized by the resolver). */
  ioReads: string[];
  /** DECLARED io.json writes (paths as recorded — absolutized by the resolver). */
  ioWrites: string[];
  /** ABSOLUTE observed reads (from the event replay); empty for the lean reader. */
  observedReads?: string[];
  /** ABSOLUTE observed writes (from the event replay); empty for the lean reader. */
  observedWrites?: string[];
}

export interface ResolveStructureOpts {
  /** The declared TEMPLATE DAG (piflow init's workflow.json) — the tier-2 fallback. Absent ⇒ run-only. */
  workflow?: { stages?: string[][]; nodes?: Record<string, { phase?: string | null; deps?: string[] }> } | null;
  /** Absolutize a possibly-relative path against the run sandbox. Default: resolve against runDir. */
  toAbs?: (p: string) => string;
  /** Strip an absolute path to a clean DISPLAY path (the edge's shown `path`). Default: identity. */
  displayPath?: (abs: string) => string;
}

/** The run-local resolved DAG shape as the runner persists it (`{ meta, profile, stages, edges }`). */
interface ResolvedDag {
  stages?: { index?: number; phase?: string | null; parallel?: boolean; nodeIds?: string[] }[];
  edges?: { from: string; to: string; files?: string[] }[];
}

function readResolvedDag(runDir: string): ResolvedDag | null {
  try {
    const f = path.join(runDir, '.pi', 'workflow.json');
    if (fssync.existsSync(f)) return JSON.parse(fssync.readFileSync(f, 'utf8')) as ResolvedDag;
  } catch { /* unparseable ⇒ fall through to the lower tiers */ }
  return null;
}

/**
 * Resolve one run's stage spine + data-flow edges by the priority ladder above. `runDir` is where the
 * run-local `.pi/workflow.json` is read from; `nodes` is the present node set (both readers pass what they
 * have). Returns `{ stages, edges, placement }` — `placement[id] = {stageIndex, lane}` for stamping nodes.
 */
export function resolveStructure(
  runDir: string,
  nodes: StructureNode[],
  opts: ResolveStructureOpts = {},
): { stages: ResolvedStage[]; edges: ResolvedEdge[]; placement: Record<string, { stageIndex: number; lane: number }> } {
  const runResolved = path.resolve(runDir);
  const toAbs = opts.toAbs ?? ((p: string) => (path.isAbsolute(p) ? p : path.join(runResolved, p)));
  const displayPath = opts.displayPath ?? ((abs: string) => abs);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const has = (id: string): boolean => nodeById.has(id);

  const resolvedDag = readResolvedDag(runDir);

  // ── STAGES ────────────────────────────────────────────────────────────────────────────────────────
  const tStages = (opts.workflow?.stages ?? [])
    .map((ids) => ids.filter(has))
    .filter((ids) => ids.length > 0);
  let stages: ResolvedStage[];
  if (resolvedDag?.stages?.length) {
    stages = resolvedDag.stages
      .map((st) => ({ phase: st.phase ?? '—', parallel: !!st.parallel, nodeIds: (st.nodeIds ?? []).filter(has) }))
      .filter((st) => st.nodeIds.length > 0)
      .map((st, i) => ({ index: i + 1, phase: st.phase, parallel: st.parallel, nodeIds: st.nodeIds }));
  } else if (tStages.length && new Set(tStages.flat()).size === nodeById.size) {
    stages = tStages.map((ids, i) => ({ index: i + 1, phase: nodeById.get(ids[0])?.phase ?? '—', parallel: ids.length > 1, nodeIds: ids }));
  } else {
    const ordered = [...nodes].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    const phaseOrder: string[] = [];
    for (const n of ordered) { const ph = n.phase || '—'; if (!phaseOrder.includes(ph)) phaseOrder.push(ph); }
    stages = phaseOrder.map((ph, i) => {
      const ids = ordered.filter((n) => (n.phase || '—') === ph).map((n) => n.id);
      return { index: i + 1, phase: ph, parallel: ids.length > 1, nodeIds: ids };
    });
  }
  const placement: Record<string, { stageIndex: number; lane: number }> = {};
  for (const st of stages) st.nodeIds.forEach((id, lane) => { placement[id] = { stageIndex: st.index, lane }; });

  // ── EDGES (same winner) ───────────────────────────────────────────────────────────────────────────
  let edges: ResolvedEdge[];
  if (resolvedDag?.edges) {
    // The resolved DAG's DECLARED data-flow edges are authoritative (one edge per contract file; a declared
    // edge with no files still draws the connection). Runtime io/events are NOT consulted for topology.
    edges = [];
    const seen = new Set<string>();
    for (const e of resolvedDag.edges) {
      if (!has(e.from) || !has(e.to) || e.from === e.to) continue;
      const files = e.files && e.files.length ? e.files : [''];
      for (const f of files) {
        const p = f ? displayPath(f) : '';
        const key = `${e.from}|${e.to}|${p}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from: e.from, to: e.to, path: p });
      }
    }
  } else {
    // FALLBACK (no run-local DAG): the DECLARED io.json ledger UNION the events-observed I/O, keyed on the
    // ABSOLUTE path so a shared edge dedupes to one and basenames never collide. First writer of a path wins
    // (declared io.json before events-observed); a well-formed workflow has one producer per path.
    const writerOf = new Map<string, string>();
    const claim = (nodeId: string, p: string): void => { const abs = toAbs(p); if (abs && !writerOf.has(abs)) writerOf.set(abs, nodeId); };
    for (const n of nodes) for (const w of n.ioWrites) claim(n.id, w);            // declared first…
    for (const n of nodes) for (const w of n.observedWrites ?? []) { if (w && !writerOf.has(w)) writerOf.set(w, n.id); } // …then observed (already absolute)
    const readsOf = (n: StructureNode): string[] => [
      ...n.ioReads.map(toAbs),
      ...(n.observedReads ?? []),
    ];
    const seen = new Set<string>();
    edges = [];
    for (const n of nodes) {
      for (const abs of readsOf(n)) {
        const from = writerOf.get(abs);
        if (!from || from === n.id) continue;
        const key = `${from}|${n.id}|${abs}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to: n.id, path: displayPath(abs) });
      }
    }
    // Fill any connection the runtime traces missed from the declared template deps, bridging THROUGH
    // profile-elided nodes to their nearest present ancestors so the downstream node stays connected.
    const wfNodes = opts.workflow?.nodes ?? {};
    const presentDeps = (id: string, seenIds = new Set<string>()): string[] => {
      const out: string[] = [];
      for (const d of wfNodes[id]?.deps ?? []) {
        if (seenIds.has(d)) continue;
        seenIds.add(d);
        if (has(d)) out.push(d);
        else out.push(...presentDeps(d, seenIds));
      }
      return out;
    };
    const pairLinked = new Set(edges.map((e) => `${e.from}|${e.to}`));
    for (const to of Object.keys(wfNodes)) {
      if (!has(to)) continue;
      for (const from of presentDeps(to)) {
        if (from === to || pairLinked.has(`${from}|${to}`)) continue;
        pairLinked.add(`${from}|${to}`);
        edges.push({ from, to, path: '' });
      }
    }
  }

  return { stages, edges, placement };
}

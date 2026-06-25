// ── readRunModel — the shared one-shot SNAPSHOT ─────────────────────────────────────────────────────
// Reads the engine-owned `.pi/` run layout (D7) — `.pi/run.json` (a RunStatus) + each node's
// `.pi/nodes/<id>/io.json` (a NodeIo) — and folds them into the one `RunModel` every view renders. It
// is the canonical SOURCE the cli `readRun` (status.ts) and the tui `buildModel` (model.mjs) each build
// a subset of today; their refactor onto this is a separate follow-up.
//
// Two load-bearing derivations, kept here so all views share ONE definition:
//   • STATUS is VERIFIED, not trusted — a node that CLAIMS completion (ok/gap/blocked) but whose
//     declared artifact is ABSENT on disk reads `blocked`, beating the self-report (runner verdict
//     ladder). `error`/pre-terminal verdicts pass through (they make no completion claim).
//   • STAGES + lanes are reconstructed from the run dir alone (it is self-describing) — the engine's
//     last-published parallel barrier (`stage.nodeIds`) groups concurrent siblings into one lane-set.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { runJsonFile, nodeIoFile } from '../runner/layout.js';
import { artifactState } from '../runner/status.js';
import type { NodeStatus, NodeStatusRecord, RunStatus } from '../runner/status.js';
import { readMarker, readCheckpointJournal, checkpointViewFrom } from '../runner/checkpoint.js';
import type { NodeIo } from '../types.js';
import type { CheckpointView, EdgeView, NodeView, RunModel, StageView } from './types.js';

/** Read `.pi/run.json` → a RunStatus, or null when absent/unparseable. */
export async function readRunJson(runDir: string): Promise<RunStatus | null> {
  try {
    return JSON.parse(await fs.readFile(runJsonFile(runDir), 'utf8')) as RunStatus;
  } catch {
    return null;
  }
}

/** Read a node's `.pi/nodes/<id>/io.json` ledger, or null. */
async function readNodeIo(runDir: string, id: string): Promise<NodeIo | null> {
  try {
    return JSON.parse(await fs.readFile(nodeIoFile(runDir, id), 'utf8')) as NodeIo;
  } catch {
    return null;
  }
}

/**
 * A node's declared-artifact paths: the io.json `writes[]` are the authoritative ledger; fall back to
 * the run-status record's `artifacts[]` paths when no ledger exists. EXISTENCE is re-checked on disk by
 * the caller — the recorded `verified`/`exists` flags are not trusted.
 */
function declaredArtifacts(rec: NodeStatusRecord, io: NodeIo | null): string[] {
  if (io?.writes?.length) return io.writes.map((w) => w.path);
  return rec.artifacts.map((a) => a.path);
}

/**
 * RE-DERIVE a node's shown status from on-disk reality (the verified-not-trusted rule). A killed/error
 * verdict is terminal; pre-terminal states pass through; any verdict that CLAIMS completion downgrades
 * to `blocked` when a declared artifact is missing.
 *
 * (G5) A node with a PENDING checkpoint marker on disk reads `awaiting-input` — verified-not-trusted in
 * spirit: the run-view shows it because the marker EXISTS on disk, not because a record claims it. A
 * resolved/absent marker doesn't change the derivation.
 */
export function deriveStatus(reported: NodeStatus, missing: string[], checkpoint?: CheckpointView | null): NodeStatus {
  if (checkpoint && checkpoint.status === 'pending') return 'awaiting-input';
  if (reported === 'error') return 'error';
  if (reported === 'pending' || reported === 'running' || reported === 'reused' || reported === 'dry') {
    return reported;
  }
  if (missing.length) return 'blocked';
  return reported;
}

/**
 * Reconstruct the stage spine + parallel lanes from the run dir alone. Singletons each form a stage in
 * file order; the engine's last-published barrier (`stage.nodeIds`) groups its concurrent siblings into
 * ONE parallel stage. Returns the stages AND stamps {stageIndex, lane} into a placement map.
 */
function buildStages(
  status: RunStatus,
): { stages: StageView[]; placement: Record<string, { stageIndex: number; lane: number }> } {
  const order = Object.keys(status.nodes);
  const barrier = (status.stage?.nodeIds ?? []).filter((id) => id in status.nodes);
  const barrierSet = new Set(barrier);

  const stages: StageView[] = [];
  for (const id of order) {
    if (barrierSet.has(id)) continue; // barrier nodes group together below, in barrier order
    stages.push({ index: stages.length + 1, phase: null, parallel: false, nodeIds: [id] });
  }
  if (barrier.length) {
    stages.push({ index: stages.length + 1, phase: null, parallel: barrier.length > 1, nodeIds: barrier });
  }
  // re-index + record placement.
  const placement: Record<string, { stageIndex: number; lane: number }> = {};
  stages.forEach((st, i) => {
    st.index = i + 1;
    st.parallel = st.nodeIds.length > 1;
    st.nodeIds.forEach((id, lane) => { placement[id] = { stageIndex: st.index, lane }; });
  });
  return { stages, placement };
}

/**
 * Read a run dir → the shared `RunModel`. Throws (rather than returning a half model) when there is no
 * readable `.pi/run.json` — a watcher/CLI surfaces that as "no run here".
 */
export async function readRunModel(runDir: string): Promise<RunModel> {
  const status = await readRunJson(runDir);
  if (!status) {
    throw new Error(`readRunModel: no readable .pi/run.json under ${path.resolve(runDir)}`);
  }

  // io ledgers (one per node) — the source of phase + declared writes + the data-flow edges.
  const ioById: Record<string, NodeIo | null> = {};
  for (const id of Object.keys(status.nodes)) ioById[id] = await readNodeIo(runDir, id);

  const { stages, placement } = buildStages(status);

  // (G5) The `__checkpoints__` resolution journal (read ONCE off `.pi/state.json`) cross-checks each
  // node's marker so a resolved checkpoint shows `resolved` + `reply`, a pending one drives `awaiting-input`.
  const ckJournal = await readCheckpointJournal(runDir);

  const nodes: NodeView[] = [];
  for (const rec of Object.values(status.nodes)) {
    const io = ioById[rec.id];
    const declared = declaredArtifacts(rec, io);
    const states = await Promise.all(
      declared.map((rel) => artifactState(path.resolve(runDir, rel), rel)),
    );
    const missing = states.filter((s) => !s.exists).map((s) => s.path);
    const place = placement[rec.id] ?? { stageIndex: 0, lane: 0 };
    const marker = await readMarker(runDir, rec.id);
    const checkpoint = checkpointViewFrom(marker, ckJournal[rec.id]) as CheckpointView | null;
    nodes.push({
      id: rec.id,
      label: rec.label,
      ...(rec.agentType ? { agentType: rec.agentType } : {}), // (G6) verbatim passthrough → GUI icon
      phase: io?.phase ?? null,
      reported: rec.status,
      status: deriveStatus(rec.status, missing, checkpoint),
      artifactsVerified: states.filter((s) => s.exists).length,
      artifactsTotal: declared.length,
      missing,
      durationMs: rec.durationMs,
      stageIndex: place.stageIndex,
      lane: place.lane,
      ...(checkpoint ? { checkpoint } : {}),
    });
  }
  // stamp the real phase (from io) onto the stages (buildStages can't see io).
  for (const st of stages) {
    const firstIo = ioById[st.nodeIds[0]];
    st.phase = firstIo?.phase ?? null;
  }

  // ── io-derived edges: a write of node A that node B READS back is the edge A→B (first writer wins) ──
  const writerOf: Record<string, string> = {};
  for (const id of Object.keys(status.nodes)) {
    for (const w of ioById[id]?.writes ?? []) if (w?.path && !(w.path in writerOf)) writerOf[w.path] = id;
  }
  const edges: EdgeView[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(status.nodes)) {
    for (const r of ioById[id]?.reads ?? []) {
      const from = r?.path ? writerOf[r.path] : undefined;
      if (!from || from === id) continue;
      const key = `${from}->${id}:${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to: id, path: r.path });
    }
  }

  return {
    run: status.run,
    done: status.done,
    ok: status.ok,
    durationMs: status.durationMs,
    provider: status.provider,
    model: status.model,
    stage: status.stage,
    totals: status.totals,
    nodes,
    stages,
    edges,
  };
}

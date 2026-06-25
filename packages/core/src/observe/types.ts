// ── @piflow/core/observe — the SHARED observability CONTRACT ────────────────────────────────────────
// ONE reader, ONE model, ONE live stream that the CLI (`piflow status`), the TUI (`piflow-tui`), and a
// future GUI all render. `RunModel` is the snapshot every view derives from; `RunUpdate` is the live
// delta the stream yields. Both are a SUPERSET of what packages/cli/src/status.ts (`RunView`/`NodeView`)
// and tui/model.mjs (`buildModel`) each build today over the `.pi/` run layout (D7) — so a
// consumer reading this source needs nothing the legacy readers had and that source did not carry.
//
// These types live HERE (src/observe/), NOT src/types.ts — a parallel branch edits src/types.ts; the
// two stay disjoint and merge clean.

import type { NodeStatus, RunStatus } from '../runner/status.js';

/**
 * (G5) The HUMAN CHECKPOINT payload a view renders — the marker (the question) cross-checked against the
 * `.pi/state.json` `__checkpoints__` journal (the resolution). Present on a node iff a checkpoint marker
 * exists on disk for it. The GUI's notification points at the awaiting node via this; once resolved it
 * carries the `reply`. The shape is the SUPERSET both `NodeView` and `RunViewNode` carry (kept in sync so
 * the live SSE snapshot and the on-demand run-view agree).
 */
export interface CheckpointView {
  status: 'pending' | 'resolved';
  kind: 'confirm' | 'input' | 'select';
  prompt: string;
  choices?: string[];
  default?: unknown;
  /** Present once resolved (from the `__checkpoints__` journal). */
  reply?: unknown;
  askedAt?: string;
  /** The question hash — a courier echoes it so the runner rejects a reply for a re-asked question. */
  hash: string;
}

/**
 * One node as a view consumes it — the union of the cli `NodeView` (verified/total artifacts + the
 * `status` RE-DERIVED from on-disk reality, the verified-not-trusted rule) and the tui node row
 * (phase + stage placement + duration). `reported` keeps the raw record field for transparency / the
 * mutation test; `status` is the derived verdict a missing declared artifact downgrades to `blocked`.
 */
export interface NodeView {
  id: string;
  label: string;
  /** (G6) The agent-PRESET label (branding) — the GUI maps it to {icon,label,color} from ~/.piflow/agents/. */
  agentType?: string;
  phase: string | null;
  /** The verdict the view SHOWS — derived from on-disk artifact reality, not the raw record field. */
  status: NodeStatus;
  /** The status the record SELF-REPORTED (kept for transparency + the mutation test). */
  reported: NodeStatus;
  /** Declared artifacts that exist on disk right now. */
  artifactsVerified: number;
  /** Declared artifacts total. */
  artifactsTotal: number;
  /** Declared artifacts found absent on disk (the reason a node reads `blocked`). */
  missing: string[];
  durationMs?: number;
  /** 1-based stage this node lands in (its parallel lane is `lane`). */
  stageIndex: number;
  /** The node's column within its stage (siblings in a parallel lane share a stage, differ by lane). */
  lane: number;
  /**
   * (G5) The human-checkpoint payload, present iff a checkpoint marker exists for this node on disk. When
   * its `status` is `pending` the node's derived `status` reads `awaiting-input` (verified-not-trusted: the
   * marker is on disk). The GUI's notification points here; the reply flows back via the courier endpoint.
   */
  checkpoint?: CheckpointView;
}

/** A reconstructed stage (a parallel barrier groups its concurrent nodes into one `parallel` stage). */
export interface StageView {
  index: number;
  phase: string | null;
  parallel: boolean;
  nodeIds: string[];
}

/**
 * A file-level data-flow edge: node `from` WROTE a path that node `to` READ back (the engine's only
 * hard guarantee — nodes coordinate through files). Derived from the per-node io.json ledgers.
 */
export interface EdgeView {
  from: string;
  to: string;
  /** The shared on-disk path that links them (the producer's write = the consumer's read). */
  path: string;
}

/**
 * THE shared snapshot. A one-shot view of a run built from `.pi/run.json` + `nodes/<id>/io.json`. Both
 * the cli table and the tui DAG render from this (and only this) — it is a superset of each.
 */
export interface RunModel {
  run: string;
  done: boolean;
  ok: boolean | null;
  durationMs: number | null;
  provider?: string;
  model?: string | null;
  /** The parallel barrier the engine last published (null between/after stages). */
  stage: RunStatus['stage'];
  /** The run-level rollup at completion (null while running). */
  totals: RunStatus['totals'];
  nodes: NodeView[];
  stages: StageView[];
  edges: EdgeView[];
}

/**
 * One live delta on the single stream. `snapshot` is yielded FIRST (the full model); then `node-status`
 * on a node's status change, `node-event` per new events.jsonl line, and `done` when the run completes.
 */
export type RunUpdate =
  | { kind: 'snapshot'; model: RunModel }
  | { kind: 'node-status'; id: string; status: NodeStatus }
  | { kind: 'node-event'; id: string; event: import('../runner/events.js').PiEvent }
  | { kind: 'done' };

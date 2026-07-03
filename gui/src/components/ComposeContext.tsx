/**
 * ComposeContext — the drag-to-compose editor's shared state, threaded the SAME way FusionContext is:
 * via React context (not React Flow node `data`), so dropping a chip re-renders the affected node without
 * rebuilding the graph wiring. It carries the active run id, the per-node AUTHORED config (the badge's
 * gate-pipeline source — see runView.gatePipelineLabels), and the one write action.
 *
 * INVARIANT (worker-types.md §"GUI — drag-to-compose"): a dropped chip is NOT GUI-local state — `dropChip`
 * POSTs it to `/__piflow/node-edit`, which mutates the per-repo TEMPLATE `node.json` the run reads (the
 * gate joins that node's `op[]` lane). The GUI NEVER owns the data; it re-reads the authored config back
 * so the edit round-trips. Same discipline as FusionContext, which never rewrites the DAG itself.
 */
import { createContext, useContext } from "react";
import type { GateChip, AuthoredNodeConfig } from "../data/runView";
import type { RailKind } from "../data/gates";

export interface ComposeApi {
  /** True while the Compose view-mode is active (nodes paint their gate drop-targets). */
  active: boolean;
  /** The run whose TEMPLATE we edit. Empty ⇒ no edits possible. */
  run: string;
  /** node id → its authored config (op[]/checkpoint/tier) — the badge's source of truth. */
  configs: Record<string, AuthoredNodeConfig>;
  /** Apply a gate chip to a node. `target` defaults to `"run"` (Slice 1.5: run-first — the gate lands on THIS
   *  run's `.pi/` first, visible immediately, template untouched); `"template"` PROMOTES it durably (future
   *  runs get it). Resolves ok/error/stub for UI feedback; a template write refreshes the node's authored
   *  config upstream. Called by the drop card's "Create gate" (run) and its "Apply to template" (promote). */
  dropChip: (nodeId: string, chip: GateChip, target?: "run" | "template") => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
  /** Open the natural-language drop card for a node. The rail's drop only records the intent (node + kind);
   *  the write happens on the card's "Create gate". The card is a full-height left overlay, not anchored. */
  openCard: (nodeId: string, kind: RailKind) => void;
  /** The node the open card is bound to (kept highlighted on the canvas while authoring); null when closed. */
  targetId: string | null;
  /** (Slice 2) The node whose compose AGENT session is mid-wire — the target renders a PENDING (ghost) hex
   *  while composing; it SOLIDIFIES from the run-view re-read once the gate lands (config is truth, inv 6).
   *  Null when no agent session is running. */
  composingNodeId: string | null;
}

export const ComposeContext = createContext<ComposeApi>({
  active: false,
  run: "",
  configs: {},
  dropChip: async () => ({ ok: false, error: "compose not active" }),
  openCard: () => {},
  targetId: null,
  composingNodeId: null,
});

export const useCompose = () => useContext(ComposeContext);

/** The MIME the palette sets on a drag and the node drop-target reads — a single key so the two agree. */
export const CHIP_DND_MIME = "application/x-piflow-gate-chip";

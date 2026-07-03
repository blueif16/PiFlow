/**
 * MarketContext — the skill-marketplace's "drop a skill on a node" state, threaded the SAME way BasisContext
 * is: via React context (not React Flow node `data`), so a drop re-renders the affected node without
 * rebuilding the graph wiring. The per-node drop slot (NodeSkillDrop) lives inside WorkflowNode — which
 * React Flow instantiates — so the context IS demanded here (props can't reach it).
 *
 * `active` mirrors "the marketplace panel is open" (the 's' toggle) — while active, every agent node shows a
 * slim skill drop slot. The drop only records the intent (node + dragged skill id + the node's current skill);
 * the write happens on the SkillDropCard's confirm — a RUN-FIRST `prompt.skill` edit (with a template promote)
 * through the existing validated write path (dropChip → POST /__piflow/node-edit → node-writeback). Unlike the
 * base-agent reassign (template-only), a skill is an OVERLAY so it bakes onto the run first. The GUI never owns
 * the data.
 */
import { createContext, useContext } from "react";

export interface MarketApi {
  /** the marketplace panel is open → agent nodes render the skill drop slot. */
  active: boolean;
  /** Open the loadout confirm card: the target node, the DRAGGED skill id, and the node's CURRENT skill
   *  (undefined ⇒ no skill yet). */
  openCard: (nodeId: string, skill: string, current?: string) => void;
  /** The node the open card is bound to (kept highlighted on the canvas); null when closed. */
  targetId: string | null;
}

export const MarketContext = createContext<MarketApi>({
  active: false,
  openCard: () => {},
  targetId: null,
});

export const useMarket = () => useContext(MarketContext);

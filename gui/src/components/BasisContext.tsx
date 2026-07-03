/**
 * BasisContext — the Basis mode's reassign-a-base-agent state, threaded the SAME way ComposeContext is:
 * via React context (not React Flow node `data`), so a drop re-renders the affected node without
 * rebuilding the graph wiring. The per-node drop slot (NodeAgentDrop) lives inside WorkflowNode — which
 * React Flow instantiates — so the compose pattern's context IS demanded here (props can't reach it).
 *
 * The drop only records the intent (node + dragged base + the node's current base); the write happens on
 * the AgentDropCard's confirm — a TEMPLATE-ONLY `agentType` edit through the existing validated write path
 * (dropChip → POST /__piflow/node-edit → node-writeback). The GUI never owns the data.
 */
import { createContext, useContext } from "react";

export interface BasisApi {
  /** Open the reassign confirm card: the target node, the DRAGGED base id, and the node's CURRENT base
   *  (undefined ⇒ bespoke — assigning a first base). */
  openCard: (nodeId: string, agentType: string, current?: string) => void;
  /** The node the open card is bound to (kept highlighted on the canvas); null when closed. */
  targetId: string | null;
}

export const BasisContext = createContext<BasisApi>({
  openCard: () => {},
  targetId: null,
});

export const useBasis = () => useContext(BasisContext);

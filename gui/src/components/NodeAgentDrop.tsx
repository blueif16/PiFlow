/**
 * NodeAgentDrop — the per-node Basis drop-target: a slim invisible band over the basis identity card
 * (NodeModeStrip stays the passive renderer beneath it) that accepts a base agent dragged from the
 * AgentRail. The drop performs NO write — it parses + validates the payload (agentChips.parseAgentChip,
 * the tested gate) and opens the reassign confirm card via BasisContext; the write happens on the card's
 * confirm. Clone of NodeGateChips' handlers with the agent MIME. `stopPropagation` keeps a click from
 * also expanding the node's HUD (mirrors NodeGateChips).
 */
import { useState } from "react";
import { useBasis } from "./BasisContext";
import { AGENT_CHIP_DND_MIME, parseAgentChip } from "../data/agentChips";
import "../styles/agentrail.css";

export function NodeAgentDrop({ nodeId, current }: { nodeId: string; current?: string }) {
  const { openCard } = useBasis();
  const [over, setOver] = useState(false);

  return (
    <div
      className={`ds-agentdrop${over ? " is-over" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(AGENT_CHIP_DND_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          if (!over) setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        const chip = parseAgentChip(e.dataTransfer.getData(AGENT_CHIP_DND_MIME));
        if (!chip) return; // not a well-formed agent payload — ignore (a gate drag never lands here)
        openCard(nodeId, chip.agentType, current);
      }}
      aria-label={`Drop a base agent onto "${nodeId}" to reassign its base (current: ${current ?? "bespoke"}).`}
    />
  );
}

/**
 * NodeSkillDrop — the per-node skill drop-target: a slim invisible band ABOVE the node card (kept clear of
 * the below-card basis band) that accepts a skill dragged from the SkillMarketPanel. The drop performs NO
 * write — it parses + validates the payload (skillChips.parseSkillChip, the tested gate) and opens the loadout
 * confirm card via MarketContext; the write happens on the card's confirm. Clone of NodeAgentDrop with the
 * skill MIME. `stopPropagation` keeps a click/drop from also expanding the node's HUD (mirrors NodeAgentDrop).
 */
import { useState } from "react";
import { useMarket } from "./MarketContext";
import { SKILL_CHIP_DND_MIME, parseSkillChip } from "../data/skillChips";
import "../styles/skillmarket.css";

export function NodeSkillDrop({ nodeId, current }: { nodeId: string; current?: string }) {
  const { openCard } = useMarket();
  const [over, setOver] = useState(false);

  return (
    <div
      className={`ds-skilldrop${over ? " is-over" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(SKILL_CHIP_DND_MIME)) {
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
        const chip = parseSkillChip(e.dataTransfer.getData(SKILL_CHIP_DND_MIME));
        if (!chip) return; // not a well-formed skill payload — ignore (an agent/gate drag never lands here)
        openCard(nodeId, chip.skill, current);
      }}
      aria-label={`Drop a skill onto "${nodeId}" to set its loadout skill (current: ${current ?? "none"}).`}
    >
      <span className="ds-skilldrop__hint" aria-hidden="true">drop a skill</span>
    </div>
  );
}

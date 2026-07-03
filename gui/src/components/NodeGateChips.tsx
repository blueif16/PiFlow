/**
 * NodeGateChips — the per-node Compose control: a DROP-TARGET that accepts a gate dragged from the GateRail,
 * and the on-node HEX ROW that renders the node's AUTHORED template pipeline (op[] + checkpoint, via
 * ComposeContext.configs). Painted beneath each node in Compose mode, the SAME slot NodeFusionToggle uses.
 *
 * Drop flow (the redesign's spine): rail hex dragged → dropped here → ComposeContext.openCard opens the
 * natural-language drop card at this node → the card's "Create gate" POSTs to /__piflow/node-edit → the gate
 * joins this node's TEMPLATE node.json → the config refreshes upstream → this row re-renders WITH the new gate.
 * config is the single source of truth; the row reflects the file. (The drop no longer writes directly.)
 *
 * `stopPropagation` keeps a click from also expanding the node's HUD (mirrors NodeFusionToggle).
 */
import { useState } from "react";
import { useCompose, CHIP_DND_MIME } from "./ComposeContext";
import { authoredGateHexes, RAIL_KINDS, type RailKind } from "../data/gates";
import { GateHex } from "./GateGlyph";

const isRailKind = (k: unknown): k is RailKind => RAIL_KINDS.some((r) => r.kind === k);

export function NodeGateChips({ nodeId }: { nodeId: string }) {
  const { run, configs, openCard } = useCompose();
  const [over, setOver] = useState(false);

  const cfg = configs[nodeId];
  const hexes = authoredGateHexes(cfg);
  const pipelineLabel = hexes.length ? hexes.map((h) => h.label).join(" → ") : "none";

  return (
    <div
      className={`ds-gatedrop${over ? " is-over" : ""}`}
      onClick={(e) => e.stopPropagation()}
      onDragOver={(e) => {
        if (!run) return;
        if (e.dataTransfer.types.includes(CHIP_DND_MIME)) {
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
        const raw = e.dataTransfer.getData(CHIP_DND_MIME);
        if (!raw) return;
        let kind: unknown;
        try { kind = (JSON.parse(raw) as { kind?: unknown }).kind; } catch { return; }
        if (!isRailKind(kind)) return;
        openCard(nodeId, kind);
      }}
      aria-label={`Drop a gate onto "${nodeId}". Gate pipeline: ${pipelineLabel}.`}
    >
      <div className="ds-gatedrop__hexes">
        {hexes.length === 0 ? (
          <span className="ds-gatedrop__empty">
            <span className="ds-hex ds-hex--ghost" style={{ ["--hex-size" as string]: "20px" }} aria-hidden="true" />
            drop a gate
          </span>
        ) : (
          hexes.map((h, i) => <GateHex key={`${h.glyph}-${i}`} desc={h} size={20} />)
        )}
      </div>
    </div>
  );
}

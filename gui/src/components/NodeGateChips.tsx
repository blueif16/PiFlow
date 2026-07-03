/**
 * NodeGateChips — the per-node Compose control: a DROP-TARGET that accepts a gate dragged from the GateRail,
 * and the on-node HEX ROW that renders the node's AUTHORED template pipeline (op[] + checkpoint, via
 * ComposeContext.configs). Painted beneath each node in Compose mode, the SAME slot NodeFusionToggle uses.
 *
 * Drop flow (the redesign's spine): rail hex dragged → dropped here → ComposeContext.openCard opens the
 * natural-language authoring overlay for this node → "Create gate" applies the gate (run-first) → the gate is
 * visible on the run; "Apply to template" promotes it into this node's TEMPLATE node.json → the compose config
 * refreshes → this row re-renders WITH the durable gate. config is the single source of truth.
 *
 * RUN-SCOPED reconciliation (Slice 1.5): the durable template pipeline is rendered as hexes; when the run
 * carries MORE gates than the template (an un-promoted run-first edit), a "· N run-scoped" tag reports it
 * truthfully — the durable gates read as hexes, the run-only ones as the tag. `runGateCount` is the run-view's
 * effective `config.gates` entry count (what's actually on this run).
 *
 * `stopPropagation` keeps a click from also expanding the node's HUD (mirrors NodeFusionToggle).
 */
import { useState } from "react";
import { useCompose, CHIP_DND_MIME } from "./ComposeContext";
import { authoredGateHexes, RAIL_KINDS, type RailKind } from "../data/gates";
import { GateHex } from "./GateGlyph";

const isRailKind = (k: unknown): k is RailKind => RAIL_KINDS.some((r) => r.kind === k);

export function NodeGateChips({ nodeId, runGateCount = 0 }: { nodeId: string; runGateCount?: number }) {
  const { run, configs, openCard, composingNodeId } = useCompose();
  const [over, setOver] = useState(false);

  const cfg = configs[nodeId];
  const hexes = authoredGateHexes(cfg);
  // Gates present on THIS RUN beyond the durable template set = un-promoted run-first edits (additive flow).
  const runOnly = Math.max(0, runGateCount - hexes.length);
  // (Slice 2) the compose AGENT is mid-wire on this node — show a PENDING (ghost) hex until the run-view re-read
  // carries the landed gate, at which point it solidifies into a real hex (config is truth, inv 6).
  const composing = composingNodeId === nodeId;
  const pipelineLabel = hexes.length ? hexes.map((h) => h.label).join(" → ") : composing ? "composing…" : "none";
  const runNote = runOnly > 0 ? `; ${runOnly} applied to this run only (not yet promoted)` : "";

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
      aria-label={`Drop a gate onto "${nodeId}". Gate pipeline: ${pipelineLabel}${runNote}.`}
    >
      <div className="ds-gatedrop__hexes">
        {hexes.length === 0 && runOnly === 0 && !composing ? (
          <span className="ds-gatedrop__empty">
            <span className="ds-hex ds-hex--ghost" style={{ ["--hex-size" as string]: "20px" }} aria-hidden="true" />
            drop a gate
          </span>
        ) : (
          <>
            {hexes.map((h, i) => <GateHex key={`${h.glyph}-${i}`} desc={h} size={20} />)}
            {composing && (
              <span
                className="ds-hex ds-hex--ghost ds-hex--pending"
                style={{ ["--hex-size" as string]: "20px" }}
                title="an agent is composing this gate…"
                aria-label="an agent is composing this gate"
                role="img"
              />
            )}
          </>
        )}
        {runOnly > 0 && (
          <span className="ds-gatedrop__runscoped" title={`${runOnly} gate${runOnly === 1 ? "" : "s"} applied to this run only — not yet promoted to the template`}>
            · {runOnly} run-scoped
          </span>
        )}
        {composing && <span className="ds-gatedrop__wiring">composing…</span>}
      </div>
    </div>
  );
}

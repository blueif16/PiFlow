/**
 * AgentRail — the Basis mode's drag SOURCE (the GateRail idiom, base agents instead of gates). Every base
 * agent in the catalog floats as a circular avatar on the left edge of the canvas; each row is draggable
 * and sets the AGENT_CHIP_DND_MIME payload carrying its preset id. Dropping one on a node's basis slot
 * opens the reassign confirm card (AgentDropCard). Hover or keyboard-focus EXPANDS a row in place to
 * reveal its name + the role prompt's first line. Basis mode only.
 *
 * Floating-chrome idiom (a941c34): body portal + a pointer-events:none layer, `auto` only on the rows,
 * so the rail never covers canvas content. Rows come PRE-SORTED from the tested projection
 * (agentRailEntries) — this component renders it verbatim.
 */
import { createPortal } from "react-dom";
import { AGENT_CHIP_DND_MIME, agentRailEntries, buildAgentChip } from "../data/agentChips";
import { AgentAvatar } from "./WorkflowNode";
import type { AgentCatalog } from "../data/runView";
import "../styles/agentrail.css";

export function AgentRail({ active, catalog }: { active: boolean; catalog: AgentCatalog }) {
  if (!active) return null;
  const rows = agentRailEntries(catalog);
  if (rows.length === 0) return null; // no catalog ⇒ no rail (never an empty chrome box)
  return createPortal(
    <div className="ds-agentrail-layer" aria-hidden={false}>
      <div className="ds-agentrail" role="toolbar" aria-label="Base agents — drag one onto a node to reassign its base">
        {rows.map((r) => (
          <button
            key={r.id}
            type="button"
            className="ds-agentrail__item"
            draggable
            aria-label={`${r.label}${r.promptLine ? ` — ${r.promptLine}` : ""}. Drag onto a node.`}
            title={r.promptLine ? `${r.label} — ${r.promptLine}` : r.label}
            onDragStart={(ev) => {
              ev.dataTransfer.setData(AGENT_CHIP_DND_MIME, JSON.stringify(buildAgentChip(r.id)));
              ev.dataTransfer.effectAllowed = "copy";
            }}
          >
            <span className="ds-agentrail__face" style={r.color ? { color: r.color } : undefined}>
              <AgentAvatar agentType={r.id} icon={r.icon} />
            </span>
            <span className="ds-agentrail__label">
              <span className="ds-agentrail__name">{r.label}</span>
              {r.promptLine && <span className="ds-agentrail__desc">{r.promptLine}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}

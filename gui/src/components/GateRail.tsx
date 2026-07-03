/**
 * GateRail — the compose editor's drag SOURCE (replaces the old bottom ChipPalette bar). Three angular
 * hexagon icons floating directly on the left edge of the canvas — no glass bar, no section titles. Each
 * icon is draggable and sets the CHIP_DND_MIME payload carrying its kind; dropping one on a node opens the
 * drop card (GateDropCard). Hover or keyboard-focus EXPANDS an icon in place to reveal its name + one-line
 * description. Compose mode only.
 *
 * Floating-chrome idiom (a941c34): body portal + a pointer-events:none layer, `auto` only on the hexes, so
 * the rail never covers canvas content. Vertically centered on the left edge, clear of the RUN FILES
 * navigator (top-left) and the zoom controls (bottom-left).
 */
import { createPortal } from "react-dom";
import { CHIP_DND_MIME } from "./ComposeContext";
import { GateHex } from "./GateGlyph";
import { RAIL_KINDS, railHex } from "../data/gates";
import "../styles/gaterail.css";

export function GateRail({ active }: { active: boolean }) {
  if (!active) return null;
  return createPortal(
    <div className="ds-gaterail-layer" aria-hidden={false}>
      <div className="ds-gaterail" role="toolbar" aria-label="Gates — drag one onto a node">
        {RAIL_KINDS.map((spec) => {
          const desc = railHex(spec.kind, spec.name);
          return (
            <button
              key={spec.kind}
              type="button"
              className="ds-rail-item"
              draggable
              aria-label={`${spec.name} — ${spec.desc}. Drag onto a node.`}
              title={`${spec.name} — ${spec.desc}`}
              onDragStart={(ev) => {
                ev.dataTransfer.setData(CHIP_DND_MIME, JSON.stringify({ kind: spec.kind }));
                ev.dataTransfer.effectAllowed = "copy";
              }}
            >
              <GateHex desc={desc} size={38} title={`${spec.name} — ${spec.desc}`} />
              <span className="ds-rail-item__label">
                <span className="ds-rail-item__name">{spec.name}</span>
                <span className="ds-rail-item__desc">{spec.desc}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

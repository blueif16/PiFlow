/**
 * NodeExpandOverlay — the portaled shell for the "clicked-up" HUD. It owns the
 * heavier scrim, focus trap + restore, Esc / scrim-click close, reduced motion,
 * and hosts the NodeHud dossier. The node morphs (shared `layoutId`) into the
 * HUD's identity panel while the other panels fan in around it.
 *
 * Rendered in a portal at <body> so it sits outside React Flow's transformed
 * pane — never clipped, never zoom-scaled, never reflowing the canvas.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as motion from "motion/react-client";
import { NodeHud } from "./NodeHud";
import { scrimVariants } from "../motion/transitions";
import type { FlowNodeData } from "./WorkflowNode";

export interface NodeExpandOverlayProps {
  id: string | null;
  data: FlowNodeData | null;
  onClose: () => void;
}

export function NodeExpandOverlay({ id, data, onClose }: NodeExpandOverlayProps) {
  const reduce = useReducedMotion() ?? false;
  const windowRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Esc to close + focus management
  useEffect(() => {
    if (!id) return;
    restoreFocusRef.current = document.activeElement as HTMLElement;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => windowRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      restoreFocusRef.current?.focus?.();
    };
  }, [id, onClose]);

  return createPortal(
    <AnimatePresence>
      {id && data && (
        <>
          <motion.div
            className="ds-scrim"
            variants={scrimVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={onClose}
          />
          {/* full-screen HUD layer; clicks on the empty area fall through to the
              scrim (close), the dossier itself captures pointer events */}
          <div
            style={{
              position: "fixed",
              inset: 0,
              zIndex: "var(--ds-z-overlay)" as unknown as number,
              display: "grid",
              placeItems: "stretch",
              padding: "clamp(10px, 1.6vh, 18px)",
              pointerEvents: "none",
            }}
          >
            <NodeHud id={id} data={data} onClose={onClose} reduce={reduce} dialogRef={windowRef} />
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

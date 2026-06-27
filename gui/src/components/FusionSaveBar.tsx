/**
 * FusionSaveBar — the bottom-center "commit your fusion edits" affordance. It shows ONLY in Fusion mode
 * while there are unsaved overrides, and persists them into THIS RUN (not the template): everything in the
 * GUI is a run, so an edit restructures the run. A two-step confirm (Save… → Save / Cancel) guards the
 * write; on success the overrides are cleared upstream (the saved structure becomes the run-view base) and
 * this bar unmounts. The actual transform + write are the SDK's (via /__piflow/save-run) — never view-local.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useFusion } from "./FusionContext";
import "../styles/modes.css";

export function FusionSaveBar({ active }: { active: boolean }) {
  const { overrides, save } = useFusion();
  const [phase, setPhase] = useState<"idle" | "confirm" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const count = Object.keys(overrides).length;
  if (!active || count === 0) return null;

  const onSave = async () => {
    setPhase("saving");
    const r = await save();
    if (r.ok) setPhase("idle"); // overrides cleared upstream ⇒ this bar unmounts
    else { setError(r.error ?? "save failed"); setPhase("error"); }
  };

  return createPortal(
    <div className="ds-fusionsave-layer">
      <GlassSurface variant="soft" className="ds-fusionsave" legibleText aria-label="Save fusion edits to this run">
        <span className="ds-fusionsave__count">{count} fusion edit{count > 1 ? "s" : ""} on this run</span>
        {phase === "idle" && (
          <button type="button" className="ds-fusionsave__btn" onClick={() => setPhase("confirm")}>Save to run…</button>
        )}
        {phase === "confirm" && (
          <>
            <span className="ds-fusionsave__ask">Restructure this run?</span>
            <button type="button" className="ds-fusionsave__btn is-primary" onClick={onSave}>Save</button>
            <button type="button" className="ds-fusionsave__btn" onClick={() => setPhase("idle")}>Cancel</button>
          </>
        )}
        {phase === "saving" && <span className="ds-fusionsave__ask">Saving…</span>}
        {phase === "error" && (
          <>
            <span className="ds-fusionsave__err" title={error ?? ""}>✗ {error}</span>
            <button type="button" className="ds-fusionsave__btn" onClick={() => setPhase("confirm")}>Retry</button>
          </>
        )}
      </GlassSurface>
    </div>,
    document.body,
  );
}

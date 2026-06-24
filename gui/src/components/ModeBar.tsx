/**
 * ModeBar — the bottom-left view-mode cluster: one grey "game key" per mode, each
 * showing its keycap (the letter to press) + a label. Click a key, or press it, to
 * toggle that mode; the active key lights up. Portaled to <body> above the overlay
 * scrim (like the MenuBar) so it stays visible and usable in BOTH the full-map view
 * and the per-node HUD view.
 *
 * The keyboard handler is global but inert while typing in a field or with a
 * modifier held (so Cmd/Ctrl+T etc. still belong to the browser).
 */
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useViewMode, VIEW_MODES } from "./ViewModeContext";
import "../styles/modes.css";

export function ModeBar() {
  const { mode, toggle } = useViewMode();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      const hit = VIEW_MODES.find((m) => m.key === e.key.toLowerCase());
      if (!hit) return;
      e.preventDefault();
      toggle(hit.mode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return createPortal(
    <div className="ds-modebar-layer">
      <GlassSurface variant="soft" className="ds-modebar" legibleText aria-label="View modes">
        {VIEW_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            className={`ds-mode-btn${mode === m.mode ? " is-active" : ""}`}
            aria-pressed={mode === m.mode}
            title={`${m.label} — press ${m.key.toUpperCase()}`}
            onClick={() => toggle(m.mode)}
          >
            <span className="ds-mode-btn__cap" aria-hidden="true">{m.key.toUpperCase()}</span>
            <span className="ds-mode-btn__label">{m.label}</span>
          </button>
        ))}
      </GlassSurface>
    </div>,
    document.body,
  );
}

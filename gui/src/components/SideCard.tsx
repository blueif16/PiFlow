/**
 * SideCard — the shared RIGHT-dock card shell. ONE floating glass card the whole right-dock family
 * (Digest · Skill · Remote skill · Market) renders its OWN content into: different renderings of the SAME
 * card. It docks to the right edge, inset from the top/right/bottom (never flush), slides OUT from the right
 * edge on open, and gives its content a generously padded scroll body + a single close control.
 *
 * The right edge is a SINGLE SLOT — the canvas keeps these panels mutually exclusive (opening one closes the
 * rest, chat included) so two cards never coexist; a new card always REPLACES the one before it.
 *
 * The shell owns: the float + margins, the glass surface + soft corners, the slide-in motion, the scroll
 * body (the card's internal padding), the close control, and Escape-to-close. Children own the content.
 * Sits at z-modal — above an open NodeHud, below the floating MenuBar/ModeBar (which collapse/relocate to
 * clear its corners).
 */
import { useEffect, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import "../styles/sidecard.css";

export function SideCard({
  open,
  onClose,
  ariaLabel,
  accent,
  width,
  closeTitle = "Close (Esc)",
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** tints the leading-edge seam — one of the right-dock kinds. */
  accent?: "digest" | "skill" | "remote" | "market";
  /** optional width override (default min(42vw, 480px)). */
  width?: string;
  closeTitle?: string;
  children: ReactNode;
}) {
  // Escape closes — centralized here so every card gets it (the shell-wide convention); layered, no scrim.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const style = width ? ({ "--ds-sidecard-w": width } as CSSProperties) : undefined;

  return createPortal(
    <div className="ds-sidecard-layer">
      <GlassSurface
        variant="window"
        className="ds-sidecard"
        legibleText
        role="dialog"
        aria-label={ariaLabel}
        data-accent={accent}
        style={style}
      >
        <button type="button" className="ds-sidecard__close" onClick={onClose} aria-label="Close" title={closeTitle}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ds-sidecard__body">{children}</div>
      </GlassSurface>
    </div>,
    document.body,
  );
}

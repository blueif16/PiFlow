/**
 * SideCard — the shared RIGHT-dock card shell. ONE floating glass card the whole right-dock family
 * (Digest · Skill · Remote skill · Market · Chat) renders its OWN content into: different renderings of the
 * SAME card. It docks to the right edge, inset from the top/right/bottom (never flush), slides OUT from the
 * right edge on open, and gives its content a padded scroll body + a single close control.
 *
 * The right edge is a SINGLE SLOT — the canvas keeps these panels mutually exclusive (opening one closes the
 * rest) so two cards never coexist; a new card always REPLACES the one before it.
 *
 * The shell owns: the float + margins, the glass surface + soft corners, the slide-in motion, the top-right
 * CHROME (a MENU handle — see CardMenuContext — beside the close, so the floating MenuBar can hide instead of
 * overlapping the card), Escape-to-close, and either a padded scroll body (viewer cards) or a bare fill the
 * child lays out itself (`padded={false}`, e.g. chat's scrolling log + pinned composer).
 *
 * Sits at z-modal — above an open NodeHud, below the floating MenuBar/ModeBar.
 */
import { useEffect, type ReactNode, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useCardMenu } from "./CardMenuContext";
import "../styles/sidecard.css";

export function SideCard({
  open,
  onClose,
  ariaLabel,
  accent,
  width,
  closeTitle = "Close (Esc)",
  padded = true,
  children,
}: {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** tints the leading-edge seam — one of the right-dock kinds. */
  accent?: "digest" | "skill" | "remote" | "market" | "chat";
  /** optional width override (default min(42vw, 480px)). */
  width?: string;
  closeTitle?: string;
  /** false ⇒ the child fills the card and owns its own scroll/padding (chat). Default ⇒ a padded scroll body. */
  padded?: boolean;
  children: ReactNode;
}) {
  const menu = useCardMenu();

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
        {/* top-right chrome — the MENU handle (the collapsed workspace/run bar, now PART of the card) + close */}
        <div className="ds-sidecard__chrome">
          {menu && (
            <button type="button" className="ds-sidecard__menu" onClick={menu.onOpenMenu} aria-label="Show menu" title="Workspace & run menu">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
                <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.3" />
              </svg>
            </button>
          )}
          <button type="button" className="ds-sidecard__close" onClick={onClose} aria-label="Close" title={closeTitle}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {padded ? <div className="ds-sidecard__body">{children}</div> : <div className="ds-sidecard__fill">{children}</div>}
      </GlassSurface>
    </div>,
    document.body,
  );
}

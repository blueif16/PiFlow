/* ============================================================
   Motif — embeds a curated SVG from /public/motifs as a recolored
   alpha-mask, tinted with the accent (solid or gradient) and given
   a varied motion. The source artwork stays monochrome; we own the
   colour + motion, so the page gets variety without 200 inline SVGs.
   Server-safe (just a styled div).
   ============================================================ */
import { cn } from "@/lib/utils";

type Motion = "spin-slow" | "spin-rev" | "pulse-soft" | "none";

export function Motif({
  src,
  className,
  motion = "none",
  tint = "var(--accent)",
}: {
  /** path under /public, e.g. "/motifs/g9.svg" */
  src: string;
  className?: string;
  motion?: Motion;
  /** any CSS background — solid token or an accent gradient */
  tint?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn("motif", motion !== "none" && motion, className)}
      style={{
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        background: tint,
      }}
    />
  );
}

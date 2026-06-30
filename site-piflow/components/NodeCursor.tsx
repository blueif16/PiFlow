"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";

/* ============================================================
   NodeCursor — the angular hover cursor for the node cards. While
   the pointer is over a clickable node ([data-node-trigger]), the
   native pointer is swapped for a small ORANGE HUD box that lerps
   after the cursor and carries the ↗ "open" arrow — the angular,
   single-spark answer to the round follow-dot, matching the site's
   bevelled grid language (a notched accent chip).

   Fine-pointer + motion-safe desktop only; on touch / coarse
   pointers / reduced-motion it never runs and the native pointer
   stays (the cards keep cursor:pointer via the unset class). The
   box snaps to the pointer on enter, eases on move, and scales out
   on leave.
   ============================================================ */

const SIZE = 30; // px — the box edge

export default function NodeCursor() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fine = window.matchMedia(
      "(min-width: 1024px) and (pointer: fine) and (prefers-reduced-motion: no-preference)",
    );
    if (!fine.matches) return;

    const el = ref.current;
    if (!el) return;

    // Mark the document so [data-node-trigger] hides its native pointer ONLY
    // when the custom cursor is actually live (reduced-motion keeps pointer).
    const root = document.documentElement;
    root.classList.add("node-cursor-active");

    let active = false;
    const xTo = gsap.quickTo(el, "x", { duration: 0.22, ease: "power3" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.22, ease: "power3" });

    const onMove = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const onNode = target?.closest("[data-node-trigger]");
      const x = e.clientX - SIZE / 2;
      const y = e.clientY - SIZE / 2;

      if (onNode) {
        if (!active) {
          active = true;
          // land at the pointer (no slide-in from a stale spot), then reveal
          gsap.set(el, { x, y });
          gsap.to(el, { scale: 1, opacity: 1, duration: 0.18, ease: "power2.out" });
        } else {
          xTo(x);
          yTo(y);
        }
      } else if (active) {
        active = false;
        gsap.to(el, { scale: 0.4, opacity: 0, duration: 0.18, ease: "power2.in" });
      }
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      root.classList.remove("node-cursor-active");
      gsap.killTweensOf(el);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[90] opacity-0 [will-change:transform]"
    >
      <div className="relative grid size-[30px] place-items-center hud-cut-tr [--hud-bevel:8px] bg-[var(--accent)] text-white shadow-[var(--shadow-md)]">
        {/* ↗ open-arrow */}
        <svg
          viewBox="0 0 24 24"
          className="relative size-[14px]"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M7 17 17 7" />
          <path d="M8 7h9v9" />
        </svg>
      </div>
    </div>
  );
}

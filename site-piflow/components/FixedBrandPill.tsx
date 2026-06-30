"use client";

/* ============================================================
   FixedBrandPill — ONE truly fixed top-left pill for the whole page.
   ------------------------------------------------------------
   Replaces the per-section copies that used to ride #top / #start /
   #layers: those were absolutely positioned, so they scrolled away
   with their section and re-appeared at the next — the pill seemed to
   move. This is a single `position: fixed` instance that just stays in
   the corner while the page scrolls (and jumps) underneath it.
   It hides ONLY over the product section (#agents), which owns its own
   top rail — showing the pill there would double the π mark. The check
   is rect-based so it's immune to ProductScreens' pin-spacer offset:
   hide while #agents has reached the top but #start hasn't yet.
   ============================================================ */

import { useEffect, useState } from "react";
import BrandPill from "@/components/BrandPill";

export default function FixedBrandPill() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    const agents = document.querySelector("#agents");
    const start = document.querySelector("#start");
    if (!agents || !start) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      // #agents owns the top (its rail is showing) but the demo hasn't
      // arrived → the product section is in view, so step aside.
      const a = agents.getBoundingClientRect().top;
      const s = start.getBoundingClientRect().top;
      setHidden(a <= 8 && s > 8);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      className={`fixed left-4 top-4 z-50 transition-opacity duration-200 sm:left-6 sm:top-6 lg:left-10 lg:top-8 ${
        hidden ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <BrandPill />
    </div>
  );
}

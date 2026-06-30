"use client";

/* ============================================================
   SnapPages — the GSAP snap for the ONE demo→composition edge.
   ------------------------------------------------------------
   ProductScreens (#agents) pins + Observer-pages internally and
   eases DOWN into #start (the demo). From there #start → #layers
   was plain native scroll, which read as BROKEN against the paged
   feel above. This wires that edge with a ScrollTrigger SNAP:
     · while #start fills the viewport, a settled scroll snaps to
       whichever end is next in the scroll DIRECTION — a downward
       flick lands cleanly on the composition first-frame, an upward
       flick returns to the demo;
     · the snap range ENDS exactly at #layers top, so once you're in
       #layers the ComposeOutro morph scrubs natively — the two
       ScrollTriggers share only that single boundary, never overlap.
   NON-hijacking (no preventDefault / Observer): the GUI demo iframe
   stays fully interactive — the page only snaps once you actually
   scroll it past the demo. Desktop + motion-safe only; everything
   else scrolls natively.
   ============================================================ */

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

export default function SnapPages() {
  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const start = document.querySelector<HTMLElement>("#start");
      const layers = document.querySelector<HTMLElement>("#layers");
      if (!start || !layers) return;

      const st = ScrollTrigger.create({
        trigger: start,
        start: "top top",
        end: "bottom top", // ends at #layers top — hands off to the morph scrub
        snap: {
          snapTo: [0, 1], // the demo (0) or the composition first-frame (1)
          directional: true, // a flick settles to the next page in that direction
          duration: { min: 0.3, max: 0.7 },
          delay: 0.08, // let trackpad momentum die before settling
          ease: "power3.inOut", // same eased feel as the panel jumps above
        },
      });

      return () => st.kill();
    });

    return () => mm.revert();
  }, []);

  return null;
}

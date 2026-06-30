"use client";

/* ============================================================
   SnapPages — the demo→composition (#start → #layers) handoff.
   ------------------------------------------------------------
   The rest of the spine pages with FORCE: ProductScreens (#agents)
   pins and an Observer (preventDefault) turns ONE gesture into ONE
   discrete jump, handing DOWN into #start. The #start → #layers edge
   must feel identical — and a passive ScrollTrigger.snap CANNOT make
   it: #start is exactly one viewport, so the snap's whole active range
   is a single viewport with two points; trackpad momentum scrolls
   straight through it (and on into the 230vh morph) before the
   scrollEnd snap can fire, so it degrades to native scroll ("just
   lands"). So we mirror ProductScreens' handoff EXACTLY:
     · a ScrollTrigger bound to #start ENABLES an Observer only while
       the demo fills the viewport (onEnter / onEnterBack) and disables
       it the moment you cross out — up into #agents or down into
       #layers;
     · while enabled, ONE forward gesture = a single eased scrollTo
       #layers, then it RELEASES (stays disabled) so the ComposeOutro
       morph scrubs on native scroll; one back gesture = scrollTo
       #agents, where ProductScreens' onEnterBack catches you on its
       last panel.
   Because the Observer is on `window` with preventDefault, BOTH
   directions MUST be handled — leaving one unhandled would prevent
   the wheel default and trap the page at #start.
   The GUI demo iframe stays interactive: a same-origin iframe consumes
   wheel/touch over itself (you pan the flowmap) and the events never
   reach the parent window, so the Observer only fires over the page
   chrome — the same boundary the pinned section already has.
   Desktop + motion-safe only; everything else scrolls natively.
   ============================================================ */

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Observer } from "gsap/Observer";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";

gsap.registerPlugin(ScrollTrigger, Observer, ScrollToPlugin);

export default function SnapPages() {
  useEffect(() => {
    const mm = gsap.matchMedia();

    // Gate matches ProductScreens / ComposeOutro: only where the paged
    // feel (and the morph) actually run.
    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const start = document.querySelector<HTMLElement>("#start");
      const layers = document.querySelector<HTMLElement>("#layers");
      const agents = document.querySelector<HTMLElement>("#agents");
      if (!start || !layers || !agents) return;

      let animating = false;
      let lockUntil = 0; // swallow the momentum that carried us onto #start

      const blocked = () => animating || performance.now() < lockUntil;

      // ONE eased jump to an adjacent section, then RELEASE control: the
      // Observer stays disabled so the destination's native-scroll
      // mechanics take over (the morph scrub below, the pin catch above).
      // The controlling ScrollTrigger re-enables it on re-entry to #start.
      const jump = (target: string) => {
        animating = true;
        obs.disable();
        gsap.to(window, {
          scrollTo: target,
          duration: 0.6,
          ease: "power2.inOut",
          onComplete: () => {
            animating = false;
          },
        });
      };

      const obs = Observer.create({
        target: window,
        type: "wheel,touch",
        wheelSpeed: -1, // match ProductScreens: onUp == a forward / down-the-page gesture
        tolerance: 10,
        preventDefault: true,
        onUp: () => {
          if (!blocked()) jump("#layers"); // forward → composition first-frame
        },
        onDown: () => {
          if (!blocked()) jump("#agents"); // back → product section (last panel)
        },
      });
      obs.disable();

      const enable = () => {
        animating = false;
        lockUntil = performance.now() + 450; // let the entry momentum die first
        obs.enable();
      };

      const st = ScrollTrigger.create({
        trigger: start,
        start: "top top",
        end: "bottom top",
        onEnter: enable, // arrived scrolling down from #agents
        onEnterBack: enable, // scrolled back up out of the #layers morph
        onLeave: () => obs.disable(), // continued down into #layers
        onLeaveBack: () => obs.disable(), // continued up into #agents
      });

      // Reload / deep-link landing already inside #start: arm the handoff
      // (onEnter only fires on a crossing, not when we start in-range).
      if (st.isActive) enable();

      return () => {
        obs.kill();
        st.kill();
      };
    });

    return () => mm.revert();
  }, []);

  return null;
}

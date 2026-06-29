"use client";

/* ============================================================
   SnapPages — one-gesture snap-paging for the lower full-screen
   pages (#layers → #start), so the 2→3→4 journey reads as one
   smooth paged flow. The product section (#agents / ProductScreens)
   owns its own pinned panel paging and the eased handoff INTO
   #layers; this picks up there:
     · within #layers/#start, ONE scroll gesture eases (power3) to
       the next/prev whole page — the same feel as the panels above;
     · at the TOP edge (#layers, gesture up) it hands back UP into
       the product section (its onEnterBack lands the last panel);
     · at the BOTTOM edge (#start, gesture down) it releases to the
       footer (native flow resumes).
   A ScrollTrigger gates the Observer so it's live ONLY inside the
   #layers..#start band — outside it, ProductScreens' Observer (or
   native scroll) is in control; the two never run at once.
   Desktop + motion-safe only; everything else scrolls natively.
   Mirrors the proven guards in ProductScreens (lock + animating).
   ============================================================ */

import { useEffect } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Observer } from "gsap/Observer";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";

gsap.registerPlugin(ScrollTrigger, Observer, ScrollToPlugin);

const PAGES = ["#layers", "#start"];

export default function SnapPages() {
  useEffect(() => {
    const mm = gsap.matchMedia();

    mm.add("(min-width: 1024px) and (prefers-reduced-motion: no-preference)", () => {
      const els = PAGES.map((s) => document.querySelector<HTMLElement>(s)).filter(
        (e): e is HTMLElement => !!e,
      );
      if (els.length < 2) return;

      let index = 0;
      let animating = false;
      let lockUntil = 0; // swallow the momentum that carried us into the band
      const blocked = () => animating || performance.now() < lockUntil;

      // Sudden, eased jump to a whole page — the panel-jump feel from above.
      const goTo = (i: number) => {
        animating = true;
        index = i;
        gsap.to(window, {
          scrollTo: { y: els[i], offsetY: 0 },
          duration: 0.7,
          ease: "power3.inOut",
          overwrite: true,
          onComplete: () => {
            animating = false;
            lockUntil = performance.now() + 120;
          },
        });
      };

      // TOP edge: hand back up into the pinned product section. Landing one
      // viewport above #layers is inside the product pin → its onEnterBack
      // re-enters on the last panel and takes the wheel back.
      const leaveUp = () => {
        animating = true;
        obs.disable();
        const agents = document.querySelector<HTMLElement>("#agents");
        const y = agents
          ? agents.offsetTop + Math.round(window.innerHeight * 0.5)
          : els[0].offsetTop - window.innerHeight;
        gsap.to(window, {
          scrollTo: y,
          duration: 0.6,
          ease: "power2.inOut",
          onComplete: () => {
            animating = false;
          },
        });
      };

      // BOTTOM edge: release to the footer; native scrolling resumes.
      const leaveDown = () => {
        animating = true;
        obs.disable();
        const last = els[els.length - 1];
        gsap.to(window, {
          scrollTo: last.offsetTop + last.offsetHeight,
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
        wheelSpeed: -1,
        tolerance: 10,
        preventDefault: true,
        onUp: () => {
          // scrolling DOWN the page → advance, or release to the footer
          if (blocked()) return;
          index < els.length - 1 ? goTo(index + 1) : leaveDown();
        },
        onDown: () => {
          // scrolling UP the page → go back, or hand to the product section
          if (blocked()) return;
          index > 0 ? goTo(index - 1) : leaveUp();
        },
      });
      obs.disable();

      const enter = (i: number) => {
        index = i;
        lockUntil = performance.now() + 450;
        animating = false;
        obs.enable();
      };

      // Gate: the Observer is live only across the #layers..#start band.
      const st = ScrollTrigger.create({
        trigger: els[0],
        start: "top top+=2",
        endTrigger: els[els.length - 1],
        end: "bottom bottom-=2",
        onEnter: () => enter(0), // arrived scrolling down at #layers
        onEnterBack: () => enter(els.length - 1), // came up from the footer at #start
        onLeave: () => obs.disable(), // past #start → footer
        onLeaveBack: () => obs.disable(), // above #layers → product section
      });

      return () => {
        obs.kill();
        st.kill();
      };
    });

    return () => mm.revert();
  }, []);

  return null;
}

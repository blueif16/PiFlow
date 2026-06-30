/* ============================================================
   Landing page — section order & our shared names (data-section):
     1. Hero               #top     data-section="hero"          <Hero/>
     2. Function page      #agents  data-section="function"      <ProductScreens/>  (Agent · Workflow · Memory)
     3. Presentation/demo  #start   data-section="presentation"  <CTA/>             (GUI / TUI showcase — file still named CTA.tsx)
     4. Compose → About    #layers  data-section="outro"         <ComposeOutro/>    (formats cells DISSOLVE → personal intro + footer, one scrubbed morph)
   Scroll handoff down the page: ProductScreens (#agents) pins +
   Observer-pages, then eases DOWN into #start; a ScrollTrigger SNAP
   (components/SnapPages) carries the #start → #layers demo→composition
   edge; #layers is then a scroll-scrubbed morph (composition → intro)
   that ALSO absorbs the page footer beneath its drawn-out divider.
   ============================================================ */
import Hero from "./_sections/Hero";
import ProductScreens from "./_sections/ProductScreens";
import CTA from "./_sections/CTA";
import ComposeOutro from "./_sections/ComposeOutro";
import SnapPages from "@/components/SnapPages";
import FixedBrandPill from "@/components/FixedBrandPill";

export default function Home() {
  return (
    <>
      <div className="grain" aria-hidden />
      {/* GSAP forced jump for the demo↔composition (#start ↔ #layers) edge */}
      <SnapPages />
      {/* one fixed top-left pill for the whole page (hides over #agents' rail) */}
      <FixedBrandPill />
      <main>
        <Hero />
        <ProductScreens />
        <CTA />
        <ComposeOutro />
      </main>
    </>
  );
}

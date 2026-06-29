/* ============================================================
   Landing page — section order & our shared names (data-section):
     1. Hero               #top     data-section="hero"          <Hero/>
     2. Function page      #agents  data-section="function"      <ProductScreens/>  (Agent · Workflow · Memory)
     3. Composition page   #layers  data-section="composition"   <LayerCards/>      (@SDK · @CLI · @Skills)
     4. Presentation/demo  #start   data-section="presentation"  <CTA/>             (GUI / TUI showcase — file still named CTA.tsx)
     +  Footer
   ============================================================ */
import Hero from "./_sections/Hero";
import ProductScreens from "./_sections/ProductScreens";
import LayerCards from "./_sections/LayerCards";
import CTA from "./_sections/CTA";
import Footer from "./_sections/Footer";
import SnapPages from "@/components/SnapPages";

export default function Home() {
  return (
    <>
      <div className="grain" aria-hidden />
      {/* one-gesture snap-paging across the lower full-screen pages (3 → 4) */}
      <SnapPages />
      <main>
        <Hero />
        <ProductScreens />
        <LayerCards />
        <CTA />
      </main>
      <Footer />
    </>
  );
}

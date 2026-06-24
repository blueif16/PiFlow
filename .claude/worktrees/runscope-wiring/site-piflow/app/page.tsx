import Nav from "./_sections/Nav";
import Hero from "./_sections/Hero";
import Loop from "./_sections/Loop";
import LayerCards from "./_sections/LayerCards";
import NodeL1 from "./_sections/NodeL1";
import ComposeL2 from "./_sections/ComposeL2";
import ControlL3 from "./_sections/ControlL3";
import Findings from "./_sections/Findings";
import Landscape from "./_sections/Landscape";
import Capabilities from "./_sections/Capabilities";
import CTA from "./_sections/CTA";
import Footer from "./_sections/Footer";

export default function Home() {
  return (
    <>
      <div className="grain" aria-hidden />
      <Nav />
      <main>
        <Hero />
        <Loop />
        <LayerCards />
        <NodeL1 />
        <ComposeL2 />
        <ControlL3 />
        <Findings />
        <Landscape />
        <Capabilities />
        <CTA />
      </main>
      <Footer />
    </>
  );
}

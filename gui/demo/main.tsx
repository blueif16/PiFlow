// The STATIC-DEMO entry — used ONLY by the marketing demo build (vite.config.demo.ts, root=demo/), never by
// the live viewer. MUST be first: installs the static-demo data shim (window.fetch + EventSource over
// `/__piflow/*`) BEFORE any component module loads, so the PUBLISHED demo answers from bundled JSON and needs
// no server. The live GUI's entry (src/main.tsx) does NOT import this — it is a pure live viewer.
import "./demoFetch";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

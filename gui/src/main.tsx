// The LIVE viewer entry — what `piflowctl gui` (npm run dev) serves. It is a PURE live viewer: it imports
// NO data shim and NO bundled data. The app talks only to the real `/__piflow/*` Vite dev middleware
// (vite.config.ts), which serves the launched project's live runs. (The static, server-less marketing demo
// has its own entry — demo/main.tsx + demo/index.html — which is the ONLY place bundled data is injected.)

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

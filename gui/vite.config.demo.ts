import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Static-demo build — produces the pure-frontend flowmap demo embedded by the marketing
 * site at `/gui-demo/` (`<iframe src="/gui-demo/">`).
 *
 * Differences from the dev config (`vite.config.ts`):
 *   - `root: demo/` so the ONLY entry is `demo/index.html` → `demo/main.tsx`, which installs the
 *     bundled-data shim (`demo/demoFetch.ts`). The LIVE viewer's entry (`gui/index.html` →
 *     `src/main.tsx`) is a pure live viewer and is NOT built here — the shim / bundled data live
 *     entirely inside this demo build and never touch the shipped GUI.
 *   - NONE of the `/__piflow/*` dev middleware plugins are registered (they're dev/preview only and
 *     read `~/.piflow` + product repos). The demo answers `/__piflow/*` entirely in the browser via
 *     the shim, so there is no server dependency in this build.
 *   - `base: "/gui-demo/"` so the built `index.html` references its assets under `/gui-demo/` (the
 *     iframe path), not `/`.
 *   - output goes straight into the marketing site's static dir.
 *
 * Both entries render the SAME shared `App` (`src/App.tsx` → `WorkflowCanvas`); only the data source
 * differs (bundled JSON via the shim here vs the live `/__piflow/*` middleware in dev).
 */
const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(here, "demo"),
  base: "/gui-demo/",
  plugins: [react()],
  build: {
    // outDir is OUTSIDE root (the marketing site's static dir) — absolute + emptyOutDir to allow it.
    outDir: resolve(here, "../site-piflow/public/gui-demo"),
    emptyOutDir: true,
  },
});

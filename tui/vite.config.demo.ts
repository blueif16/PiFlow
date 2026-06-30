import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Static-demo build — produces the pure-frontend TUI monitor embedded by the marketing site at
 * `/tui-demo/` (`<iframe src="/tui-demo/index.html">`). It mounts the REAL piflow TUI App
 * (`tui/components.mjs`) inside ink-canvas → xterm.js, rendering from the SAME curated data the GUI demo
 * uses (`site-piflow/demo-data/`, wired in `demo/App.jsx`). Mirrors `gui/vite.config.demo.ts`.
 *
 *   - `root` is `tui/demo` (its own `index.html` → `main.jsx` → `App.jsx`).
 *   - `base: "/tui-demo/"` so the built `index.html` references its assets under the iframe path.
 *   - output goes straight into the marketing site's static dir.
 *
 * The polyfill block (`define` + `resolve.dedupe`/`resolve.alias`) is the inlined replica of
 * `ink-canvas/plugin`'s `inkCanvasPolyfills()` Vite config. We don't import the published plugin because
 * its `dist/plugin.js` does a top-level `import "webpack"` (for its separate *webpack* plugin), which
 * breaks loading the module in a Vite-only project. The Vite plugin itself only injects the
 * define/dedupe/alias below — replicated verbatim from its source.
 */
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const r = (p: string) => require.resolve(p);

export default defineConfig({
  root: resolve(here, "demo"),
  base: "/tui-demo/",
  plugins: [react()],
  define: {
    global: "globalThis",
    "process.env": "{}",
  },
  resolve: {
    dedupe: ["react", "react-dom", "react-reconciler", "ink", "react/jsx-runtime", "react/jsx-dev-runtime"],
    alias: {
      "node:buffer": r("buffer/index.js"),
      "node:stream": r("readable-stream"),
      "node:events": r("events/events"),
      "node:process": r("ink-canvas/shims/process"),
      // ink 7's use-window-size pulls terminal-size (Node-only tty/child_process);
      // ink-canvas ships a browser shim with stable fallback dimensions.
      "terminal-size": r("ink-canvas/shims/terminal-size"),
    },
  },
  build: {
    outDir: resolve(here, "../site-piflow/public/tui-demo"),
    emptyOutDir: true,
  },
});

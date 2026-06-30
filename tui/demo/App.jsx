import React from "react";
import { InkCanvas } from "ink-canvas";
// The REAL piflow TUI view layer — browser-pure (imports only react/ink/htm/./dag.mjs). It renders from
// `config.source`; here we feed it the static source over a captured bundle (demo/capture.mjs), so the
// terminal monitor runs entirely in the browser, off the SAME @piflow/core/observe data the GUI demo shows.
import { App } from "../components.mjs";
import { makeStaticSource } from "../source-static.mjs";
import { adaptRunView } from "../adapt.mjs";
// The SHARED curated demo data (the SAME fleet index + rich RunViews the GUI demo renders). We build the
// TUI's static source FROM it at build time: the fleet index gives namespaces+threads; each thread's rich
// RunView is adapted into the TUI view shape, keyed by the thread's runDir (what buildModel resolves on).
import indexJson from "../../site-piflow/demo-data/index.json";
const runViewModules = import.meta.glob("../../site-piflow/demo-data/run-view/*.json", { eager: true, import: "default" });
// key the rich RunViews by run id (basename without `.json`) so a thread's `run` resolves its view.
const runViewByRun = {};
for (const [path, json] of Object.entries(runViewModules)) {
  runViewByRun[path.split("/").pop().replace(/\.json$/, "")] = json;
}

// LIGHT theme — ink's color NAMES (green/red/cyan/yellow/gray/magenta) resolve through xterm's 16-slot ANSI
// palette, so we re-map those slots to brand-aligned, light-legible values; NOT a pixel invert (which would
// flip hue and break the status semantics). Tokens mirror site-piflow/app/globals.css (--fg, --fg-faint).
// bright* == normal so bold text never shifts hue.
const LIGHT = {
  background: "#ffffff",
  foreground: "#171717",          // --fg (ink)
  cursor: "#171717",
  cursorAccent: "#ffffff",
  selectionBackground: "#ffe6d9", // peach wash (~ --accent-subtle)
  black: "#171717",
  red: "#dc2626",
  green: "#15803d",
  yellow: "#b45309",              // amber — plain yellow is invisible on white
  blue: "#1d4ed8",
  magenta: "#a21caf",
  cyan: "#0e7490",                // the TUI's primary accent, deepened for white
  white: "#525252",               // --fg-muted
  brightBlack: "#8a8a8a",         // --fg-faint → ink 'gray' / dimmed secondary text
  brightRed: "#dc2626",
  brightGreen: "#15803d",
  brightYellow: "#b45309",
  brightBlue: "#1d4ed8",
  brightMagenta: "#a21caf",
  brightCyan: "#0e7490",
  brightWhite: "#171717",
};

// Build the static source's `{ namespaces, models }` from the shared fleet index:
//   • namespaces — one row per product×namespace, carrying that namespace's threads verbatim, with the
//     product `root` as both `dir` and `runDir` (the discoverFleet shape the App's fleet view reads).
//   • models     — keyed by `thread.runDir` (what makeStaticSource.buildModel resolves on), each the rich
//     RunView adapted into the TUI view. A thread whose RunView file is missing is skipped (its detail
//     pane degrades to the emptyView notice rather than crashing).
const namespaces = [];
const models = {};
for (const product of indexJson.products || []) {
  for (const ns of product.namespaces || []) {
    namespaces.push({ name: ns.name, dir: product.root, runDir: product.root, threads: ns.threads || [] });
    for (const thread of ns.threads || []) {
      const rich = runViewByRun[thread.run];
      if (!rich) continue; // no curated RunView for this thread — leave it to emptyView.
      models[thread.runDir] = adaptRunView(rich);
    }
  }
}

// FLEET mode (fleet:true) → the App shows the namespace → thread → detail dashboard the way the real
// terminal monitor does, driven by the shared curated data. Read-only: the static source's stream is a
// no-op and file/export degrade to a notice.
export default function App2() {
  return (
    <div style={{ height: "100vh", width: "100vw", background: "#ffffff" }}>
      <InkCanvas
        focused
        terminalOptions={{ fontSize: 13, theme: LIGHT }}
        style={{ height: "100%", width: "100%" }}
      >
        <App config={{ fleet: true, every: 2, source: makeStaticSource({ namespaces, models }) }} />
      </InkCanvas>
    </div>
  );
}

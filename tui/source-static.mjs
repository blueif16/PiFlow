// ── tui/source-static.mjs ───────────────────────────────────────────────────────
// A PURE, browser-safe Source over PRE-DISTILLED data — NO node imports, so it bundles for the web. It
// serves the SAME shapes the fs source produces: `namespaces` (what discoverFleet/discoverNamespaces
// return) and a per-runDir `models` map (what buildModel returns), both captured ahead of time from the
// shared @piflow/core/observe surface. This is what mounts the REAL TUI App (components.mjs) in the
// browser — e.g. the site /tui-demo — so the GUI and the TUI render from one observation front.
//
// A captured demo is a SNAPSHOT: the live stream is a no-op, and file viewing / Mermaid export degrade to
// an inline notice rather than touching a filesystem that isn't there.

// Minimal empty view so a missing model never crashes the App (the fs source returns emptyModel; we mirror
// that shape inline rather than importing model.mjs, which would pull node:fs into the browser bundle).
function emptyView(id) {
  return {
    run: { id: id || null, provider: null, model: null, done: false, ok: null, durationMs: null, elapsedMs: null, stage: null, staleMs: null, missing: true, extractErr: null },
    stages: [], stageTimes: [], nodes: {}, timeline: { t0: 0, t1: 1, rows: [] },
    pathways: { halted: false, haltNode: null, reused: [], pending: [], running: [], escalated: [] },
    totals: { nodes: 0, toolCalls: 0, tokensBillable: 0, cost: 0 },
  };
}

/**
 * Build a Source from a captured bundle `{ namespaces, models }`:
 *   • namespaces — the `[{ name, dir, runDir, threads:[ThreadRow] }]` list discoverFleet returns.
 *   • models     — map of `thread.runDir → view` (the object buildModel returns), one per thread.
 */
export function makeStaticSource(bundle = {}) {
  const namespaces = bundle.namespaces || [];
  const models = bundle.models || {};
  return {
    async discoverFleet() { return namespaces; },
    async discoverNamespaces() { return namespaces; },
    async buildModel({ runDir } = {}) { return models[runDir] || emptyView(runDir); },
    // Snapshot demo — no live tail to fold; return a no-op unsubscribe so the App's effect is happy.
    subscribeRun() { return () => {}; },
    // No filesystem in the browser — the overlay shows a notice instead of file bytes.
    openFile(_ns, f) {
      return { rel: f.rel, abs: null, size: 0, binary: false, lines: ['(file preview is unavailable in this demo)'] };
    },
    openExternal() { /* no OS handoff in the browser */ },
    writeExport() { return 'export is unavailable in this demo'; },
  };
}

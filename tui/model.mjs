// ── tui/model.mjs ───────────────────────────────────────────────────────
// The renderer-AGNOSTIC data layer for visualizing ONE pi-flow run — now a THIN ADAPTER over the SHARED
// observability source (`@piflow/core/observe`). It reads the run through `readRunModel(runDir)` — the
// ONE reader the CLI, the TUI, and a future GUI all share — and subscribes to `watchRun(runDir)` for
// the live tail. There is NO bespoke `.pi/` reader here anymore: status derivation, stage/lane
// reconstruction, and the io-derived data-flow edges all live in the shared source; this file only
// MAPS the shared `RunModel` into the view shape the renderers (components.mjs / dag.mjs) already
// consume, and DERIVES the cosmetic live extras (the running-node text tail) from the streamed
// `node-event` PiEvents — never by re-reading `.pi/` files.
//
// Per-node token/cost counts, tool breakdown, thinking-char totals, and Gantt start/end timestamps come
// from the RICH run-view (`buildRunView`, the SAME distiller the GUI uses) — see `loadBuildRunView` below.
// Where the rich view is unavailable (no built `dist`, or no `.pi/run.json`) we fall back to the lean
// `readRunModel` snapshot, whose missing telemetry the view null-guards. The live running-node tail
// (text · tools · thinking) is still folded from the streamed `node-event` PiEvents, never by re-reading
// `.pi/` files.
import { readRunModel, watchRun, loadRegistry, buildSnapshot } from '@piflow/core';
import { pathToFileURL, fileURLToPath } from 'node:url';
import nodePath from 'node:path';

// ── pure mappers — re-homed in the BROWSER-PURE `./adapt.mjs` ──────────────────────────────────────────
// `adaptModel`/`overlayRichTelemetry`/`overlayRichIo`/`adaptRunView` + the `baseName`/`emptyModel` helpers
// carry NO node or `@piflow/core` dependency, so they live in `./adapt.mjs` (which the marketing-site TUI
// demo imports to render a `run-view/<run>.json` in the browser). We import them for the filesystem path
// below AND re-export them verbatim so existing importers (status-signals.test, source-fs, …) are unchanged.
import { adaptModel, overlayRichTelemetry, overlayRichIo, adaptRunView, emptyModel, baseName } from './adapt.mjs';
export { adaptModel, overlayRichTelemetry, overlayRichIo, adaptRunView, emptyModel, baseName } from './adapt.mjs';

// `summarizeRun` is RE-HOMED in `@piflow/core/observe` (the ONE shared thread-row builder the CLI, the TUI,
// and the GUI all render) — the TUI no longer keeps a divergent copy that drifted from it. Re-exported so
// the single-run `discoverNamespaces` below (and any importer) keeps the same name.
export { summarizeRun } from '@piflow/core';
import { summarizeRun } from '@piflow/core';

// ── rich run-view loader — the SAME builder the GUI dynamic-imports ───────────────────────────────────
// `buildRunView` lives in `@piflow/core/observe` but that subpath is NOT in the package's `exports` map,
// so a bare `import '@piflow/core/observe'` is blocked (ERR_PACKAGE_PATH_NOT_EXPORTED). We mirror the GUI's
// resolution (gui/vite.config.ts): resolve the EXPORTED main entry to find the built package on disk, then
// file-URL `import()` the sibling `observe/index.js` — which bypasses package `exports` resolution and
// modifies nothing in core. Cached after first load; `null` (graceful fallback) if the dist isn't built.
let _buildRunView; // undefined = not tried; null = unavailable; fn = loaded
async function loadBuildRunView() {
  if (_buildRunView !== undefined) return _buildRunView;
  try {
    const mainPath = fileURLToPath(import.meta.resolve('@piflow/core'));
    const obs = nodePath.join(nodePath.dirname(mainPath), 'observe', 'index.js');
    const mod = await import(pathToFileURL(obs).href);
    _buildRunView = typeof mod.buildRunView === 'function' ? mod.buildRunView : null;
  } catch { _buildRunView = null; }
  return _buildRunView;
}

/** Build the rich run-view for a run dir, or null if unavailable (dist not built / no run.json). */
async function tryRichView(runDir) {
  const build = await loadBuildRunView();
  if (!build) return null;
  try { return build(runDir).view; }
  catch { return null; }
}

// ── snapshot: readRunModel → the legacy buildModel() view shape ──────────────────────
// `RunModel` (the shared snapshot) is a SUPERSET of what the view needs for structure (nodes with
// derived status + stageIndex/lane, the stage spine, the io-derived edges). We re-key its `nodes` array
// into the `{id: node}` map the renderers index, and reconstruct each node's io.inputs/outputs from the
// shared `edges` (a write of A that B reads back = edge A→B) so the per-node inspector + the DAG still
// draw the data flow. One definition of "the truth", many views.
export async function buildModel({ runDir, run } = {}) {
  // STRUCTURE from the lean snapshot: status/stage/lane + the io.json-DERIVED data-flow edges. This is the
  // FALLBACK structure — when the rich view is available, `overlayRichTelemetry` adopts its resolved-DAG
  // stages + edges (the GUI's authoritative topology) over these, which a real run's empty io.json lacks.
  let model;
  try { model = await readRunModel(runDir); }
  catch { return emptyModel(run); }
  const view = adaptModel(model, run);
  // TELEMETRY + STRUCTURE overlay: real per-node tokens/ctx/tools AND the resolved-DAG stages/edges/files
  // from the RICH run-view (the SAME distiller the GUI renders). A no-op when the rich view is unavailable
  // (dist not built / no run.json) — the view then keeps the lean snapshot's io-ledger structure.
  const rich = await tryRichView(runDir);
  if (rich) overlayRichTelemetry(view, rich);
  return view;
}

// The pure mappers `overlayRichTelemetry`, `overlayRichIo`, `adaptModel`, plus the `emptyModel`/`baseName`
// helpers now live in `./adapt.mjs` (browser-pure) and are imported + re-exported at the top of this file.

// ── live tail: accumulated from the shared watchRun node-event stream ─────────────────
// The running-node output tail (and the tool/thinking cosmetics) are DERIVED from the streamed
// `node-event` PiEvents — NOT by re-reading `.pi/nodes/<id>/events.jsonl`. `subscribeRun` drives the
// shared stream and folds each node-event into a per-node accumulator the view reads.

/** Reconstruct the assistant text + tool tally a node-event PiEvent carries (the slimmed delta shape). */
function foldEvent(acc, event) {
  const a = event?.assistantMessageEvent || event?.event || event;
  const t = a?.type ?? event?.type;
  const d = a?.delta;
  if ((t === 'text_delta' || t === 'content_delta') && typeof d === 'string') acc.text += d;
  else if (t === 'thinking_delta' && typeof d === 'string') acc.thinkChars += d.length;
  else if (event?.type === 'tool_execution_start') {
    acc.toolCalls += 1;
    const tn = event.toolName;
    if (typeof tn === 'string') acc.toolBreakdown[tn] = (acc.toolBreakdown[tn] || 0) + 1;
  }
  acc.eventCount += 1;
  return acc;
}

function newAcc() { return { text: '', thinkChars: 0, toolCalls: 0, eventCount: 0, toolBreakdown: {} }; }

/**
 * Subscribe to the SHARED live stream for one run dir. `onModel(model)` fires on each snapshot/status
 * delta with the adapted view model; `onTail(byNode)` fires on each node-event with the per-node live
 * accumulators (text tail · toolCalls · thinking chars · toolBreakdown). Returns an unsubscribe fn.
 * All live data comes from the stream — this opens NO `.pi/` file itself.
 */
export function subscribeRun({ runDir, run, onModel, onTail, pollMs } = {}) {
  const ctrl = new AbortController();
  const accs = new Map(); // nodeId → live accumulator
  (async () => {
    try {
      for await (const u of watchRun(runDir, { signal: ctrl.signal, pollMs })) {
        if (ctrl.signal.aborted) break;
        if (u.kind === 'snapshot') {
          // STRUCTURE from the stream's lean model; OVERLAY real tokens/ctx/tools from the rich re-distill
          // (a no-op when unavailable). The live running-node tail is folded separately by the consumer.
          const model = adaptModel(u.model, run);
          const rich = await tryRichView(runDir);
          if (ctrl.signal.aborted) break;
          if (rich) overlayRichTelemetry(model, rich);
          onModel?.(model);
        }
        else if (u.kind === 'node-status') { /* status deltas are reflected by the next snapshot poll */ }
        else if (u.kind === 'node-event') {
          const acc = accs.get(u.id) || newAcc();
          foldEvent(acc, u.event);
          accs.set(u.id, acc);
          onTail?.(Object.fromEntries(accs));
        }
      }
    } catch { /* a stream error never crashes the TUI; the last good model stays on screen */ }
  })();
  return () => ctrl.abort();
}

// ── single-run "discovery": a run dir is one namespace with one thread ───────────────────────────────
// A `piflow-tui <rundir>` monitors ONE run. We keep the namespace→thread→detail SHAPE the view layer
// expects (so components.mjs is unchanged) by projecting the single run dir into a one-namespace /
// one-thread list — summarized via the SHARED `summarizeRun` (re-homed in @piflow/core/observe), no
// bespoke `.pi/` read and no divergent row builder.

/** Project the single run dir → the one-namespace list the view layer iterates. Async (shared reader). */
export async function discoverNamespaces({ runDir } = {}) {
  if (!runDir) return [];
  const sum = await summarizeRun(runDir);
  if (!sum) return [];
  return [{
    name: basenameOf(runDir),
    dir: resolveDir(runDir),
    runDir: resolveDir(runDir),
    threads: [sum],
  }];
}

// ── fleet discovery: the SAME registered repos the GUI shows, mapped to the App's namespace list ──────
// With NO `<rundir>`, the TUI monitors the whole FLEET. `buildSnapshot(loadRegistry())` (the ONE fleet
// builder the GUI also consumes) returns products → namespaces(workflows) → threads(ThreadRow). We FLATTEN
// every product's namespaces into one flat list in the EXACT shape `components.mjs`'s App iterates —
// `{ name, dir, runDir, threads:[ThreadRow] }` — keeping every namespace and every thread. Each thread is a
// shared ThreadRow that already carries its OWN absolute `runDir`, so drilling in opens THAT run via the
// existing buildModel/subscribeRun path (which read `thread.runDir`, not the namespace's). The namespace
// `dir`/`runDir` (used by the App only for the export path + the file-overlay base) is the product `root`.
export async function discoverFleet() {
  let snapshot;
  try { snapshot = await buildSnapshot(loadRegistry()); }
  catch { return []; }
  const out = [];
  for (const product of snapshot.products || []) {
    for (const ns of product.namespaces || []) {
      // Disambiguate same-named namespaces across products in the picker (e.g. two repos with `unfiled`).
      const multi = (snapshot.products || []).length > 1;
      out.push({
        name: multi ? `${product.name}/${ns.name}` : ns.name,
        dir: product.root,
        runDir: product.root,
        threads: ns.threads || [],
      });
    }
  }
  return out;
}

// path helpers kept local (no node:path import gymnastics; the run dir is already absolute from pi-tui).
function resolveDir(p) { return p; }
function basenameOf(p) {
  const parts = String(p).split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  return last === '.pi' ? parts[parts.length - 2] || last : last;
}

// ── tui/source-fs.mjs ─────────────────────────────────────────────────────────
// The NODE-backed Source: ALL of the App's environment I/O (run data + file ops) lives here, so
// `components.mjs` stays renderer-agnostic and browser-mountable. The four data methods are the SHARED
// observability adapters from `./model.mjs` (readRunModel/watchRun/buildSnapshot); the file methods are the
// in-terminal overlay reader, the OS-handoff for binaries, and the Mermaid export — moved out of the view
// layer verbatim. A browser entry injects `./source-static.mjs` (pre-distilled data) instead of this.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discoverNamespaces, discoverFleet, buildModel, subscribeRun } from './model.mjs';

const NUL = String.fromCharCode(0);
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.bin', '.wasm']);

// Read a file for the in-terminal overlay viewer. Text files come back as lines; binaries (and very
// large files) come back flagged so the overlay shows metadata instead of garbage bytes.
function readForOverlay(abs) {
  try {
    const size = fs.statSync(abs).size;
    if (BIN_EXT.has(path.extname(abs).toLowerCase()) || size > 1024 * 1024) return { size, binary: true, lines: [] };
    const raw = fs.readFileSync(abs, 'utf8');
    if (raw.includes(NUL)) return { size, binary: true, lines: [] };
    return { size, binary: false, lines: raw.split('\n') };
  } catch (e) { return { size: 0, binary: false, lines: [`(cannot read: ${e && e.message || e})`] }; }
}

/** The node Source — the live, fs-backed environment the terminal entry (`pi-tui.mjs`) injects. */
export function makeFsSource() {
  return {
    // ── run data (the shared @piflow/core/observe adapters) ──
    discoverNamespaces,
    discoverFleet,
    buildModel,
    subscribeRun,

    // ── file ops ──
    /** Resolve a node file relative to its run dir and read it for the overlay viewer. */
    openFile(ns, f) {
      const rel = f.path || f.rel;
      const abs = path.isAbsolute(rel) ? rel : path.join(ns.runDir, rel);
      const data = readForOverlay(abs);
      return { rel: f.rel, abs, size: data.size, binary: data.binary, lines: data.lines };
    },
    /** Hand a binary (image, etc.) to the OS default app — text is shown IN the TUI. Best-effort. */
    openExternal(abs) {
      try {
        const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
        const args = process.platform === 'win32' ? ['/c', 'start', '', abs] : [abs];
        spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
      } catch { /* best-effort */ }
    },
    /** Persist a Mermaid snapshot beside the run dir; returns the notice line (throws on fs failure). */
    writeExport(ns, content) {
      const file = path.join(ns.runDir, 'graph.mmd');
      fs.writeFileSync(file, content);
      return `✔ saved ${path.relative(ns.dir, file)}`;
    },
  };
}

// Shared plumbing for the control-server handlers — the SAME resolution the GUI's Vite middleware used,
// lifted into @piflow/server so dev (Vite) and prod (`piflowctl serve`) share ONE implementation.
//
// The handlers reach @piflow/core's built `observe`/compiler dist and the pure host libs (index-snapshot,
// checkpoint-reply, node-writeback, control-session) by ABSOLUTE path via `findUp`, then dynamic-import them.
// This is deliberate: it never bundles core's heavy barrel into the Vite config (esbuild) and it keeps the
// package free of a static core-dist import, so the exact same handler runs under both consumers. Paths are
// repo-root-relative (`packages/core/dist/...`, `gui/scripts/lib/...`); `findUp` climbs from cwd AND this
// module's dir (`packages/server/dist`) until the repo root — resolving from Vite (cwd=gui/) and from a
// standalone `serve` (cwd=anywhere; this module lives inside the piflow install) alike.

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

export type Next = () => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void | Promise<void>;

const _upCache = new Map<string, string | null>();
/** Walk UP from cwd / this module's dir until repo-root-relative `rel` exists; cached per `rel`. */
export function findUp(rel: string): string | null {
  if (_upCache.has(rel)) return _upCache.get(rel)!;
  const bases = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const base of bases) {
    let dir = base;
    for (let i = 0; i < 8; i++) {
      const p = join(dir, rel);
      if (existsSync(p)) { _upCache.set(rel, p); return p; }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  _upCache.set(rel, null);
  return null;
}

/** A pure host lib under gui/scripts/lib (index-snapshot / checkpoint-reply / node-writeback / control-session). */
export const findLib = (name: string): string | null => findUp(`gui/scripts/lib/${name}`);
/** A built @piflow/core dist module by its dist-relative subpath. */
export const findCore = (sub: string): string | null => findUp(`packages/core/dist/${sub}`);

export { pathToFileURL };

export const sendJson = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/** Read a request body with a size cap (default 1 MB — replies/messages/edits are tiny). */
export const readBody = (req: IncomingMessage, cap = 1_000_000): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    let tooBig = false;
    req.on("data", (c) => {
      data += c;
      if (data.length > cap) { tooBig = true; req.destroy(); }
    });
    req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(data)));
    req.on("error", reject);
  });

/** Resolve a run id → its run dir + the owning product's workspace root + the sibling runs of the SAME
 *  workflow (the `historyDirs` baseline for expectedMs / slow-anomaly detection), from the LIVE index (so a
 *  run added since launch resolves). Shared by the stream/run-view/run-digest/file endpoints' lookups. */
export async function resolveRunDir(run: string): Promise<{ runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null> {
  const lib = findLib("index-snapshot.mjs");
  if (!lib) return null;
  try {
    const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
    const ix = await buildSnapshot(loadScopedRegistry());
    for (const p of ix.products ?? [])
      for (const ns of p.namespaces ?? []) {
        const hit = (ns.threads ?? []).find((t: { run?: string; runDir?: string }) => t.run === run && t.runDir);
        if (hit) {
          const historyDirs = (ns.threads ?? []).flatMap((t: { runDir?: string }) => (t.runDir ? [t.runDir] : []));
          return { runDir: hit.runDir, workspaceRoot: p.root ?? null, historyDirs };
        }
      }
  } catch { /* fall through */ }
  return null;
}

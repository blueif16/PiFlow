import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Resolve a file by walking UP from the cwd / this config's dir until `rel` exists. Used to locate the
 * built core `observe` dist and the shared index-snapshot lib by ABSOLUTE path — so esbuild never tries to
 * bundle them into the Vite config and we never pull core's heavy barrel. Cached per `rel`.
 */
const _upCache = new Map<string, string | null>();
function findUp(rel: string): string | null {
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

const sendJson = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/**
 * Serve the GLOBAL piflow index/products to the static GUI — WITHOUT copying collected data into the repo
 * (the data/SDK boundary rule: no index.json under gui/public). `/__piflow/index.json` is LIVE: it
 * recomputes the snapshot from the registry (~/.piflow/products.json) on EVERY request via the shared
 * builder (gui/scripts/lib/index-snapshot.mjs), so a run that starts or progresses after the server
 * launched shows up without a manual `npm run data:index`. `/__piflow/products.json` returns the registry.
 */
function piflowGlobalIndex(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/(index|products)\.json(?:\?.*)?$/);
    if (!m) return next();
    const lib = findUp("scripts/lib/index-snapshot.mjs");
    if (!lib) return sendJson(res, 500, { error: "index-snapshot lib not found — is this the piflow gui?" });
    try {
      const { loadRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
      const registry = loadRegistry();
      const body = m[1] === "products" ? registry : await buildSnapshot(registry);
      sendJson(res, 200, body);
    } catch (e) {
      sendJson(res, 500, { error: `index build failed (${String(e)})` });
    }
  };
  return {
    name: "piflow-global-index",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * Live RUN telemetry bridge — `GET /__piflow/stream/<run>` is an SSE feed of the EXACT `RunUpdate` stream
 * `@piflow/core/observe` `watchRun(runDir)` yields. No run-status logic is reimplemented: the run folder
 * is resolved from the SAME live index, then each delta (snapshot → node-status → node-event → done) is
 * piped to the browser. The companion + live canvas subscribe to this for live state. Dev + preview only.
 */
function piflowRunStream(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/stream\/([^/?]+)/);
    if (!m) return next();
    const run = decodeURIComponent(m[1]);

    // resolve runDir from the LIVE index (so a run added since launch is followable).
    let runDir: string | null = null;
    const lib = findUp("scripts/lib/index-snapshot.mjs");
    if (lib) {
      try {
        const { loadRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
        const ix = await buildSnapshot(loadRegistry());
        for (const p of ix.products ?? [])
          for (const ns of p.namespaces ?? [])
            for (const t of ns.threads ?? [])
              if (t.run === run && t.runDir) runDir = t.runDir;
      } catch { /* fall through to 404 */ }
    }
    if (!runDir) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered? (piflow gui / npm run data:index)` });

    const obs = findUp("packages/core/dist/observe/index.js");
    if (!obs) return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
    let watchRun: (dir: string, opts?: { signal?: AbortSignal; pollMs?: number }) => AsyncIterable<unknown>;
    try {
      ({ watchRun } = await import(pathToFileURL(obs).href));
    } catch (e) {
      return sendJson(res, 500, { error: `failed to load observe (${String(e)}) — run: npm run build` });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const ac = new AbortController();
    const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch { /* socket gone */ } }, 15000);
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(ping); ac.abort(); };
    req.on("close", cleanup);
    res.on("close", cleanup);

    const write = (obj: unknown) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket gone */ } };
    write({ kind: "meta", run, runDir });

    try {
      for await (const update of watchRun(runDir, { signal: ac.signal })) {
        write(update);
        if ((update as { kind?: string }).kind === "done") break;
      }
    } catch (e) {
      write({ kind: "stream-error", error: String(e) });
    } finally {
      clearInterval(ping);
      try { res.end(); } catch { /* already ended */ }
    }
  };

  return {
    name: "piflow-run-stream",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), piflowGlobalIndex(), piflowRunStream()],
  server: { port: 5173, host: true },
});

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Serve the GLOBAL piflow index (the source of truth in ~/.piflow — see
 * gui/scripts/build-index.mjs) to the static GUI WITHOUT copying collected data
 * into the repo. Per the project data/SDK boundary rule, no index.json is ever
 * committed under gui/public. Dev + preview middleware only; reads the file on
 * each request so a fresh `npm run data:index` shows up without a restart.
 */
function piflowGlobalIndex(): Plugin {
  const handler = async (req: { url?: string }, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/(index|products)\.json(?:\?.*)?$/);
    if (!m) return next();
    res.setHeader("Content-Type", "application/json");
    try {
      res.end(await readFile(join(homedir(), ".piflow", `${m[1]}.json`)));
    } catch {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: `no ~/.piflow/${m[1]}.json — run: npm run data:index` }));
    }
  };
  return {
    name: "piflow-global-index",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * Live RUN telemetry bridge — `GET /__piflow/stream/<run>` is an SSE feed of the
 * EXACT `RunUpdate` stream `@piflow/core/observe` `watchRun(runDir)` yields (the
 * one source the CLI/TUI already render). It does NOT reimplement any run-status
 * logic: it resolves the run's folder from the same `~/.piflow/index.json` the GUI
 * reads, then pipes each delta (snapshot → node-status → node-event → done) to the
 * browser. The companion subscribes to this for live "where are we" context.
 *
 * The observe reader is imported LAZILY from the built core dist by ABSOLUTE path
 * (found by walking up to `packages/core/dist/observe/index.js`) so we never pull
 * core's heavy barrel (esbuild/daytona) and esbuild never tries to bundle it into
 * the Vite config. Dev + preview middleware only.
 */
function piflowRunStream(): Plugin {
  let observePath: string | null | undefined;
  const findObserve = (): string | null => {
    if (observePath !== undefined) return observePath;
    const bases = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
    for (const base of bases) {
      let dir = base;
      for (let i = 0; i < 8; i++) {
        const p = join(dir, "packages", "core", "dist", "observe", "index.js");
        if (existsSync(p)) return (observePath = p);
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
      }
    }
    return (observePath = null);
  };

  // Resolve a run id → its absolute run dir, from the SAME global index the GUI reads.
  const resolveRunDir = async (run: string): Promise<string | null> => {
    try {
      const ix = JSON.parse(await readFile(join(homedir(), ".piflow", "index.json"), "utf8"));
      for (const p of ix.products ?? [])
        for (const ns of p.namespaces ?? [])
          for (const t of ns.threads ?? [])
            if (t.run === run && t.runDir) return t.runDir as string;
    } catch { /* no index / unparseable → null */ }
    return null;
  };

  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/stream\/([^/?]+)/);
    if (!m) return next();
    const run = decodeURIComponent(m[1]);

    const runDir = await resolveRunDir(run);
    if (!runDir) {
      return sendJson(res, 404, { error: `no run "${run}" in ~/.piflow/index.json — run: npm run data:index` });
    }
    const obs = findObserve();
    if (!obs) {
      return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
    }
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
    res.setHeader("X-Accel-Buffering", "no"); // defeat proxy buffering so deltas arrive live
    res.flushHeaders?.();

    const ac = new AbortController();
    const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch { /* socket gone */ } }, 15000);
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(ping); ac.abort(); };
    req.on("close", cleanup);
    res.on("close", cleanup);

    const write = (obj: unknown) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket gone */ } };
    write({ kind: "meta", run, runDir }); // first frame: which run dir resolved (debug + client title)

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

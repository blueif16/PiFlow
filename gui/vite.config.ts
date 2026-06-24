import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerResponse } from "node:http";

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

export default defineConfig({
  plugins: [react(), piflowGlobalIndex()],
  server: { port: 5173, host: true },
});

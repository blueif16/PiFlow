// `piflowctl serve` — stand up the piflow control plane (control API + GUI) on THIS host. Long-lived;
// Ctrl-C stops it. This is the process a laptop runs for the `local` context and a cloud VM runs for the
// `cloud` context — identical binary, the only difference is which endpoint a piflow context points at.
//
// Scope: like `piflowctl gui`, it resolves the launched project (+ nested products) via the shared
// `resolveScope` and exposes it through PIFLOW_SCOPE_ROOTS, which the handlers' `loadScopedRegistry` reads —
// so `serve` shows EXACTLY the project you launched it in, never the whole global registry.

import path from "node:path";
import { existsSync } from "node:fs";
import { resolveScope } from "@piflow/core";
import { createServer } from "./create-server.js";
import { findUp } from "./resolve.js";

export interface ServeOptions {
  port: number;
  host: string;
  token: string | null;
  staticDir: string | null;
  roots: string[];
  open: boolean;
  /** Template allow-list for POST /api/runs/start (empty ⇒ allow all — today's local behavior). */
  allowedTemplates: string[];
}

/** Split a `path.delimiter`-separated list of template dirs (from --allow-templates or PIFLOW_ALLOWED_TEMPLATES). */
const splitTemplates = (v: string | undefined): string[] => v?.split(path.delimiter).filter(Boolean) ?? [];

export function parseServeArgs(argv: string[]): ServeOptions {
  const out: ServeOptions = {
    port: Number(process.env.PIFLOW_PORT) || 5273,
    host: process.env.PIFLOW_HOST || "127.0.0.1",
    token: process.env.PIFLOW_TOKEN ?? null,
    staticDir: null,
    roots: [],
    open: false,
    allowedTemplates: splitTemplates(process.env.PIFLOW_ALLOWED_TEMPLATES),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host") out.host = argv[++i];
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--static") out.staticDir = argv[++i];
    else if (a === "--roots") out.roots.push(...(argv[++i]?.split(path.delimiter).filter(Boolean) ?? []));
    else if (a === "--allow-templates") out.allowedTemplates = splitTemplates(argv[++i]);
    else if (a === "--open") out.open = true;
    else if (a === "--no-scope") out.roots = ["*none*"]; // sentinel: force the global fleet view
  }
  return out;
}

export async function runServeCli(argv: string[]): Promise<void> {
  const opts = parseServeArgs(argv);

  // scope → PIFLOW_SCOPE_ROOTS (the handlers' loadScopedRegistry reads it).
  if (opts.roots.length && opts.roots[0] !== "*none*") {
    process.env.PIFLOW_SCOPE_ROOTS = opts.roots.join(path.delimiter);
  } else if (opts.roots[0] === "*none*") {
    delete process.env.PIFLOW_SCOPE_ROOTS;
  } else {
    const { scopeRoot, roots } = resolveScope(process.cwd());
    if (roots.length) {
      process.env.PIFLOW_SCOPE_ROOTS = roots.join(path.delimiter);
      process.stdout.write(`piflowctl serve: ${roots.length} project(s) in scope under ${scopeRoot}\n`);
      for (const r of roots) process.stdout.write(`  • ${r}\n`);
    } else {
      delete process.env.PIFLOW_SCOPE_ROOTS;
      process.stdout.write(`piflowctl serve: no piflow project at/under ${scopeRoot} — showing the global fleet view.\n`);
    }
  }

  // static GUI: --static, else the piflow install's gui/dist (built via: cd gui && npm run build).
  let staticDir = opts.staticDir;
  if (!staticDir) { const idx = findUp("gui/dist/index.html"); staticDir = idx ? path.dirname(idx) : null; }
  if (staticDir && !existsSync(path.join(staticDir, "index.html"))) staticDir = null;
  if (!staticDir) process.stdout.write("piflowctl serve: gui/dist not found — serving the API only (build the GUI: cd gui && npm run build).\n");

  if (opts.allowedTemplates.length) {
    process.stdout.write(`piflowctl serve: start-run restricted to ${opts.allowedTemplates.length} allow-listed template(s).\n`);
  }

  const server = createServer({ staticDir, token: opts.token, allowedTemplates: opts.allowedTemplates });
  server.on("error", (e) => { process.stderr.write(`piflowctl serve: ${String(e)}\n`); process.exitCode = 1; });
  server.listen(opts.port, opts.host, () => {
    const shown = opts.host === "0.0.0.0" ? "localhost" : opts.host;
    process.stdout.write(`piflowctl serve: control plane on http://${shown}:${opts.port}${opts.token ? " (auth: bearer token required)" : ""}  (Ctrl-C to stop)\n`);
  });

  // stay alive until signalled.
  await new Promise<void>((resolve) => {
    const stop = () => { server.close(() => resolve()); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

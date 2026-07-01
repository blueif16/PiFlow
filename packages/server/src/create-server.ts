// createServer — assemble the piflow control plane as one http.Server: the control API (all handlers) +
// optional static GUI + an optional bearer-token auth gate. The SAME server runs on a laptop (`piflowctl
// serve`) and inside a cloud control VM (P5) — the only difference is a context's endpoint. The auth gate is
// a SEAM here (default off = today's localhost dev behavior); P5 hardens it (required before public exposure).

import http from "node:http";
import { createApiMiddleware } from "./handlers.js";
import { serveStatic } from "./static.js";
import { sendJson, type Middleware } from "./resolve.js";

export interface CreateServerOptions {
  /** Directory of the built GUI (gui/dist). null/omitted ⇒ serve the API only. */
  staticDir?: string | null;
  /** Bearer token; when set, EVERY request (API, SSE, static) must present it (Authorization: Bearer, or ?token=). */
  token?: string | null;
  /** Handlers to run BEFORE the built-in API (e.g. the P2b start-run handler). */
  extraApi?: Middleware[];
  /** Template allow-list for POST /api/runs/start. null/omitted/empty ⇒ allow all (local dev); when set,
   *  only requests resolving to a listed templateDir may launch a run (403 otherwise) — P5 cloud hardening. */
  allowedTemplates?: string[] | null;
}

/** Require the bearer token on every request. EventSource can't set headers, so `?token=` is also accepted. */
function bearerGate(token: string): Middleware {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "");
    if (presented !== token) return sendJson(res, 401, { error: "unauthorized" });
    next();
  };
}

export function createServer(opts: CreateServerOptions = {}): http.Server {
  const api = createApiMiddleware(opts.extraApi ?? [], opts.allowedTemplates);
  const staticMw = opts.staticDir ? serveStatic(opts.staticDir) : null;
  const gate = opts.token ? bearerGate(opts.token) : null;

  // API first; unmatched → static; unmatched → 404.
  const handle: Middleware = (req, res, finalNext) =>
    api(req, res, () => (staticMw ? staticMw(req, res, finalNext) : finalNext()));

  return http.createServer((req, res) => {
    const notFound = () => { if (!res.headersSent) sendJson(res, 404, { error: "not found" }); else { try { res.end(); } catch { /* already ended */ } } };
    if (gate) gate(req, res, () => handle(req, res, notFound));
    else handle(req, res, notFound);
  });
}

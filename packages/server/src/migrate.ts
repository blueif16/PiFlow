// P6 — the migration endpoints: the REMOTE half of a one-click `context migrate`. The laptop orchestrates
// (freeze source → bundle → adopt on target → context use target); whichever side is a REMOTE serve exposes
// these three routes so the orchestrator can drive it over HTTP. The LOCAL side uses the @piflow/core
// primitives (requestFreeze / packRunDir / unpackRunDir) directly with no HTTP — so upload (laptop→cloud)
// and download (cloud→laptop) are the SAME orchestration with the local/remote roles swapped.
//
//   POST /__piflow/migrate/<run>/freeze  → drop the .pi/freeze sentinel; the live runner parks at the next
//                                          node boundary (RunStatus.frozen). Client polls run-view for it.
//   GET  /__piflow/migrate/<run>/bundle  → packRunDir(runDir) → the gzipped portable snapshot (application/gzip).
//   POST /__piflow/migrate/<run>/adopt   → unpack the posted bundle into the target's run-dir, then spawn a
//                                          detached `piflowctl run <tpl> --run <id>` that RESUMES via the
//                                          journal (done nodes reused, tail runs). Allow-list-gated (it is
//                                          the same credentialed RCE surface as start-run).

import { spawn } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { requestFreeze, packRunDir, unpackRunDir } from "@piflow/core";
import { findUp, resolveRunDir, sendJson, type Middleware } from "./resolve.js";
import { resolveTemplateDir, runsHomeFor, isTemplateAllowed, buildStartRunArgv, type StartBody } from "./start-run.js";

const MIGRATE_RE = /^\/__piflow\/migrate\/([^/?]+)\/(freeze|bundle|adopt)(?:\?.*)?$/;

/** Read a BINARY request body (the gzip bundle) — bundles can be many MB, so accumulate Buffers (never a
 *  string, which would corrupt the bytes) under a generous-but-bounded cap. */
function readBodyBuffer(req: IncomingMessage, cap = 256_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > cap) { tooBig = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => (tooBig ? reject(new Error("bundle too large")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/**
 * The migration middleware, bound to the same template allow-list as start-run (adopt spawns a credentialed
 * runner). Factory so the CLI threads the allow-list in; `piflowMigrate` below is the allow-all default.
 */
export function makePiflowMigrate(allowedTemplates?: string[] | null): Middleware {
  return async (req, res, next) => {
    const m = req.url?.match(MIGRATE_RE);
    if (!m) return next();
    const run = decodeURIComponent(m[1]);
    const verb = m[2];

    // ── freeze: park the live run at its next node boundary ──────────────────────────────────────────
    if (verb === "freeze") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to freeze a run" });
      const rd = await resolveRunDir(run);
      if (!rd) return sendJson(res, 404, { error: `no run "${run}" in scope` });
      await requestFreeze(rd.runDir);
      return sendJson(res, 202, { run, frozen: "requested" });
    }

    // ── bundle: ship the portable run-dir snapshot ──────────────────────────────────────────────────
    if (verb === "bundle") {
      if (req.method !== "GET") return sendJson(res, 405, { error: "use GET to download a bundle" });
      const rd = await resolveRunDir(run);
      if (!rd) return sendJson(res, 404, { error: `no run "${run}" in scope` });
      const buf = await packRunDir(rd.runDir);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="${run}.piflow-bundle.gz"`);
      res.end(buf);
      return;
    }

    // ── adopt: reload the bundle onto THIS host and resume via the journal ───────────────────────────
    if (verb === "adopt") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to adopt a run" });
      // The template ref + sandbox ride the query (the body is the raw gzip bundle).
      const url = new URL(req.url ?? "", "http://localhost");
      const body: StartBody = {
        templateDir: url.searchParams.get("templateDir") ?? undefined,
        product: url.searchParams.get("product") ?? undefined,
        workflow: url.searchParams.get("workflow") ?? undefined,
        // Resume LOCAL-in-this-host by default — the point of migrating is to run on the target host.
        sandbox: url.searchParams.get("sandbox") ?? "local",
      };
      const tpl = await resolveTemplateDir(body);
      if (!tpl.ok) return sendJson(res, 400, { error: tpl.error });
      if (!isTemplateAllowed(tpl.templateDir, allowedTemplates)) return sendJson(res, 403, { error: "template not allowed" });

      const runsHome = runsHomeFor(tpl.templateDir) ?? path.join(path.dirname(tpl.templateDir), "runs");
      const destRunDir = path.join(runsHome, run);

      let bundle: Buffer;
      try { bundle = await readBodyBuffer(req); } catch (e) { return sendJson(res, 400, { error: `bundle read failed (${String(e)})` }); }
      try { await unpackRunDir(bundle, destRunDir); } catch (e) { return sendJson(res, 400, { error: `bundle unpack failed (${String(e)})` }); }

      // Spawn the detached resume — same argv builder as start-run, keyed to the SAME run id so its journal
      // (just unpacked) drives reuse of the completed nodes and runs only the tail. No --from needed.
      const argv = buildStartRunArgv(tpl.templateDir, run, body);
      const cliBin = findUp("packages/cli/dist/cli.js");
      const cwd = tpl.productRoot ?? process.cwd();
      try {
        const child = cliBin
          ? spawn(process.execPath, [cliBin, ...argv], { cwd, detached: true, stdio: "ignore" })
          : spawn("piflowctl", argv, { cwd, detached: true, stdio: "ignore" });
        child.on("error", (e) => { process.stderr.write(`migrate/adopt: resume spawn failed (${String(e)})\n`); });
        child.unref();
      } catch (e) {
        return sendJson(res, 500, { error: `failed to resume the adopted run (${String(e)})` });
      }

      return sendJson(res, 202, {
        run,
        runDir: destRunDir,
        streamUrl: `/__piflow/stream/${encodeURIComponent(run)}`,
        runViewUrl: `/__piflow/run-view/${encodeURIComponent(run)}`,
        adopted: true,
      });
    }

    return next();
  };
}

/** The default migration middleware — no allow-list (allow all), matching today's local behavior. */
export const piflowMigrate: Middleware = makePiflowMigrate();

// POST /__piflow/templates — INSTALL a template onto this control plane, so a locally-authored workflow can
// run in the cloud with NO image rebuild. The missing half of the local⇄cloud symmetry: run routing, credential
// mint, freeze/bundle/adopt all exist; the only thing that had to be baked was the template on disk. This
// endpoint receives a gzipped template dir (the SAME packRunDir bundle migrate uses) + a product/workflow
// identity, unpacks it under the plane's UPLOADS ROOT as a real D9 product (`<uploads>/<product>/.piflow/
// <workflow>/template`), and — because that uploads root is an allow-list entry — the template is instantly
// launchable by POST /api/runs/start (and adoptable by migrate). Bearer-gated by the server's auth seam; the
// path segments are validated so a `../` product/workflow can never escape the uploads root (RCE-adjacent).

import path from "node:path";
import { existsSync } from "node:fs";
import { unpackRunDir } from "@piflow/core";
import { sendJson, readBodyBuffer, type Middleware } from "./resolve.js";

const TEMPLATES_RE = /^\/__piflow\/templates(?:\?.*)?$/;

/** A product/workflow id used as a path segment: leading alphanumeric then [._-], NO separators, NO `..`. */
export function isSafeSegment(s: string | null | undefined): s is string {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s) && !s.includes("..");
}

export function makePiflowTemplatesInstall(uploadsRoot?: string | null): Middleware {
  return async (req, res, next) => {
    if (!req.url?.match(TEMPLATES_RE)) return next();
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to install a template" });
    if (!uploadsRoot) return sendJson(res, 501, { error: "template push not enabled — start serve with --uploads <dir>" });

    const url = new URL(req.url ?? "", "http://localhost");
    const product = url.searchParams.get("product");
    if (!product) return sendJson(res, 400, { error: "provide ?product= (and optional ?workflow=)" });
    const workflow = url.searchParams.get("workflow") ?? product;
    // SECURITY: product/workflow become path segments — reject traversal / separators BEFORE touching the fs.
    if (!isSafeSegment(product) || !isSafeSegment(workflow))
      return sendJson(res, 400, { error: "invalid product/workflow — path segments only ([A-Za-z0-9._-], no separators, no '..')" });

    const root = path.resolve(uploadsRoot);
    const dest = path.join(root, product, ".piflow", workflow, "template");
    // Defense in depth: the resolved dest must remain strictly UNDER the uploads root.
    const rel = path.relative(root, dest);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return sendJson(res, 400, { error: "resolved template path escapes the uploads root" });

    let bundle: Buffer;
    try { bundle = await readBodyBuffer(req); } catch (e) { return sendJson(res, 400, { error: `bundle read failed (${String(e)})` }); }
    try { await unpackRunDir(bundle, dest); } catch (e) { return sendJson(res, 400, { error: `bundle unpack failed (${String(e)})` }); }
    // A template MUST carry meta.json — reject a non-template bundle (loadTemplate would fail downstream anyway).
    if (!existsSync(path.join(dest, "meta.json"))) return sendJson(res, 400, { error: "bundle has no meta.json — not a piflow template" });

    return sendJson(res, 202, { installed: true, templateDir: dest, product, workflow });
  };
}

/** Default install middleware — no uploads root (push disabled). The CLI wires the real root in. */
export const piflowTemplatesInstall: Middleware = makePiflowTemplatesInstall();

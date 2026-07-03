// `cloud push` / auto-push-on-run: pack a LOCAL template dir and install it on a cloud control plane
// (POST /__piflow/templates), so a locally-authored workflow runs in the cloud with NO image rebuild. This is
// the one primitive that closes local⇄cloud symmetry — run routing, credential mint, and freeze/bundle/adopt
// already exist; the only thing that had to be on the plane's disk was the template. Injectable fetch + pack so
// the unit tests never open a socket or touch the fs.

import path from "node:path";
import { packRunDir } from "@piflow/core";
import type { ContextEntry } from "./context-store.js";

export interface PushDeps {
  fetchImpl?: typeof fetch;
  /** Pack a dir → gzip bundle (the SAME format the plane's unpackRunDir expects). Default: core packRunDir. */
  packDir?: (dir: string) => Promise<Buffer>;
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** The template's path ON THE PLANE (under its uploads root) — the run/adopt body uses THIS, not the local path. */
  templateDir?: string;
  product?: string;
  workflow?: string;
  error?: string;
}

/**
 * Derive {product, workflow} from a `.piflow/<wf>/template` dir: workflow = `<wf>`; product defaults to the
 * same (a single-workflow push installs as product==workflow). Overridable via flags. PURE.
 */
export function deriveTemplateIdentity(
  templateDir: string,
  override: { product?: string; workflow?: string } = {},
): { product: string; workflow: string } {
  const abs = path.resolve(templateDir);
  const wfDir = path.basename(path.dirname(abs)); // `.piflow/<wf>/template` → `<wf>`
  const workflow = override.workflow ?? wfDir;
  const product = override.product ?? workflow;
  return { product, workflow };
}

/**
 * Pack a local template dir and POST it to a cloud context's `/__piflow/templates`. Returns the plane-side
 * templateDir on a 202. On a non-202 (e.g. 501 push-disabled on a bake-only plane) returns {ok:false} so the
 * caller can DEGRADE GRACEFULLY (fall back to today's send-the-local-path behavior).
 */
export async function pushTemplate(
  entry: ContextEntry,
  templateDir: string,
  override: { product?: string; workflow?: string } = {},
  deps: PushDeps = {},
): Promise<PushResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const packDir = deps.packDir ?? packRunDir;
  const { product, workflow } = deriveTemplateIdentity(templateDir, override);
  const bundle = await packDir(path.resolve(templateDir));
  const base = entry.baseUrl.replace(/\/$/, "");
  const url = `${base}/__piflow/templates?product=${encodeURIComponent(product)}&workflow=${encodeURIComponent(workflow)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/gzip",
    ...(entry.token ? { Authorization: `Bearer ${entry.token}` } : {}),
  };
  const r = (await fetchImpl(url, { method: "POST", headers, body: bundle })) as Response;
  if (r.status !== 202) {
    const error = await r.text().catch(() => "");
    return { ok: false, status: r.status, error };
  }
  const json = (await r.json().catch(() => ({}))) as { templateDir?: string; product?: string; workflow?: string };
  return { ok: true, status: r.status, templateDir: json.templateDir, product: json.product ?? product, workflow: json.workflow ?? workflow };
}

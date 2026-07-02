// The piflow control-API handlers — lifted VERBATIM from gui/vite.config.ts so the Vite dev middleware and
// the standalone `piflowctl serve` share ONE implementation (no logic fork). Each handler is a plain
// (req,res,next) middleware: it `next()`s when the route doesn't match, otherwise it owns the response.
// `createApiMiddleware()` chains them; anything unmatched falls through to the caller's `next` (static files).
//
// The only change from the Vite originals is resolution: core dist + host libs are located via
// findCore/findLib (repo-root-relative findUp) instead of the gui-cwd-relative rels — see resolve.ts.

import { readFile, writeFile, readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { findCore, findLib, pathToFileURL, readBody, resolveRunDir, sendJson, type Middleware, type Next } from "./resolve.js";
import { piflowStartRun, makePiflowStartRun } from "./start-run.js";
import { piflowMigrate, makePiflowMigrate } from "./migrate.js";
import { piflowContexts, piflowMigrateRun, piflowMigrateStatus } from "./contexts.js";

/** `GET /__piflow/{index,products}.json` — LIVE scoped snapshot (recomputed per request). */
export const piflowGlobalIndex: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/(index|products)\.json(?:\?.*)?$/);
  if (!m) return next();
  const lib = findLib("index-snapshot.mjs");
  if (!lib) return sendJson(res, 500, { error: "index-snapshot lib not found — is this the piflow gui?" });
  try {
    const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
    const registry = loadScopedRegistry();
    const body = m[1] === "products" ? registry : await buildSnapshot(registry);
    sendJson(res, 200, body);
  } catch (e) {
    sendJson(res, 500, { error: `index build failed (${String(e)})` });
  }
};

/** `GET /__piflow/stream/<run>` — SSE of the exact `watchRun(runDir)` RunUpdate stream. */
export const piflowRunStream: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/stream\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);

  // resolve runDir from the LIVE index (so a run added since launch is followable). Resolve the SAME
  // workspaceRoot + sibling historyDirs the /run-view handler passes to buildRunView, so the live stream's
  // enriched nodes (derived.time + workspace-relative paths) are byte-identical to /run-view (P4 parity).
  let runDir: string | null = null;
  let workspaceRoot: string | null = null;
  const historyDirs: string[] = [];
  const lib = findLib("index-snapshot.mjs");
  if (lib) {
    try {
      const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
      const ix = await buildSnapshot(loadScopedRegistry());
      for (const p of ix.products ?? [])
        for (const ns of p.namespaces ?? []) {
          const hit = (ns.threads ?? []).find((t: { run?: string; runDir?: string }) => t.run === run && t.runDir);
          if (!hit) continue;
          runDir = hit.runDir;
          workspaceRoot = p.root ?? null;
          for (const t of ns.threads ?? []) if (t.runDir) historyDirs.push(t.runDir);
        }
    } catch { /* fall through to 404 */ }
  }
  if (!runDir) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered? (piflowctl gui / npm run data:index)` });

  const obs = findCore("observe/index.js");
  if (!obs) return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
  let watchRun: (dir: string, opts?: { signal?: AbortSignal; pollMs?: number; historyDirs?: string[]; workspaceRoot?: string | null }) => AsyncIterable<unknown>;
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
    for await (const update of watchRun(runDir, { signal: ac.signal, historyDirs, workspaceRoot })) {
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

/** `GET /__piflow/run-view/<run>` — distill the run's `.pi/` tree via core `buildRunView`. */
export const piflowRunView: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/run-view\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);

  let runDir: string | null = null;
  let workspaceRoot: string | null = null;
  const historyDirs: string[] = [];
  const lib = findLib("index-snapshot.mjs");
  if (lib) {
    try {
      const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
      const ix = await buildSnapshot(loadScopedRegistry());
      for (const p of ix.products ?? [])
        for (const ns of p.namespaces ?? []) {
          const hit = (ns.threads ?? []).find((t: { run?: string; runDir?: string }) => t.run === run && t.runDir);
          if (!hit) continue;
          runDir = hit.runDir;
          workspaceRoot = p.root ?? null;
          // sibling runs of the SAME workflow are the prior-run baseline (expectedMs)
          for (const t of ns.threads ?? []) if (t.runDir) historyDirs.push(t.runDir);
        }
    } catch { /* fall through to 404 */ }
  }
  if (!runDir) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered? (piflowctl gui / npm run data:index)` });

  const obs = findCore("observe/index.js");
  if (!obs) return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
  try {
    const { buildRunView } = await import(pathToFileURL(obs).href);
    const { view } = buildRunView(runDir, { historyDirs, workspaceRoot });
    sendJson(res, 200, view);
  } catch (e) {
    sendJson(res, 500, { error: `run-view build failed for "${run}" (${String(e)})` });
  }
};

/** `GET /__piflow/run-digest/<run>` — the run-view route's twin: distill the run, then PROJECT it to the
 *  agent-facing RunDigest (per-node verdicts + cost spine + the ranked anomaly worklist + failure-onset
 *  localization). This is the run-LEVEL observation lens; run-view stays the wide per-node human view. */
export const piflowRunDigest: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/run-digest\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);

  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered? (piflowctl gui / npm run data:index)` });
  const { runDir, workspaceRoot, historyDirs } = resolved;

  const obs = findCore("observe/index.js");
  if (!obs) return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
  try {
    const { buildRunView, projectRunDigest } = await import(pathToFileURL(obs).href);
    const { view } = buildRunView(runDir, { historyDirs, workspaceRoot });
    sendJson(res, 200, projectRunDigest(view));
  } catch (e) {
    sendJson(res, 500, { error: `run-digest build failed for "${run}" (${String(e)})` });
  }
};

// A moa panel is REQUIRED; when neither the node nor ~/.piflow/fusion.json supplies one, the preview/save
// falls back to these tiers so the toggle is demoable with zero config.
const DEMO_PANEL = ["fast", "balanced", "deep"];

/** `GET /__piflow/preview/<run>?overrides=<json>` — recompile the template with fusion toggled on. */
export const piflowPreview: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/preview\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);

  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
  const templateDir = join(resolved.runDir, "..", "..", "template");
  if (!existsSync(templateDir)) return sendJson(res, 404, { error: `no template for "${run}" at ${templateDir} (preview needs the canonical <wf>/template layout)` });

  let overrides: Record<string, string> = {};
  const raw = new URL(req.url!, "http://localhost").searchParams.get("overrides");
  if (raw) { try { overrides = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "overrides must be JSON" }); } }

  const core = findCore("index.js");
  const obs = findCore("observe/index.js");
  if (!core || !obs) return sendJson(res, 500, { error: "@piflow/core dist not found — run: npm run build (at repo root)" });
  try {
    const { loadTemplate, withNodeFusion, expandFusion, compile, loadFusionConfig, loadModelTiers, FusionConfigError } = await import(pathToFileURL(core).href);
    const { previewView } = await import(pathToFileURL(obs).href);

    let spec = await loadTemplate(templateDir);
    for (const [nodeId, mode] of Object.entries(overrides)) {
      if (mode !== "moa" && mode !== "best-of-n") continue;
      const current = spec.nodes.find((n: { label: string; fusion?: object }) => n.label === nodeId)?.fusion ?? {};
      spec = withNodeFusion(spec, nodeId, { ...current, mode });
    }
    const fcfg = loadFusionConfig();
    const defaults = { ...fcfg.defaults, panel: fcfg.defaults.panel ?? DEMO_PANEL };
    try {
      spec = expandFusion(spec, { defaults, tiers: loadModelTiers() });
    } catch (e) {
      if (e instanceof FusionConfigError) return sendJson(res, 422, { error: String((e as Error).message) });
      throw e;
    }
    sendJson(res, 200, previewView(compile(spec), { run }));
  } catch (e) {
    sendJson(res, 500, { error: `preview build failed for "${run}" (${String(e)})` });
  }
};

/** `POST /__piflow/save-run/<run>?overrides=<json>` — bake the fusion edit into THIS run's `.pi/`. */
export const piflowSaveRun: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/save-run\/([^/?]+)/);
  if (!m) return next();
  if ((req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { error: "use POST" });
  const run = decodeURIComponent(m[1]);

  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
  const templateDir = join(resolved.runDir, "..", "..", "template");
  if (!existsSync(templateDir)) return sendJson(res, 404, { error: `no template for "${run}" at ${templateDir}` });

  let overrides: Record<string, string> = {};
  const raw = new URL(req.url!, "http://localhost").searchParams.get("overrides");
  if (raw) { try { overrides = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "overrides must be JSON" }); } }
  if (!Object.keys(overrides).length) return sendJson(res, 400, { error: "no edits to save" });

  const core = findCore("index.js");
  const obs = findCore("observe/index.js");
  if (!core || !obs) return sendJson(res, 500, { error: "@piflow/core dist not found — run: npm run build (at repo root)" });
  try {
    const { loadTemplate, withNodeFusion, expandFusion, compile, loadFusionConfig, loadModelTiers, FusionConfigError } = await import(pathToFileURL(core).href);
    const { previewView } = await import(pathToFileURL(obs).href);

    let spec = await loadTemplate(templateDir);
    for (const [nodeId, mode] of Object.entries(overrides)) {
      if (mode !== "moa" && mode !== "best-of-n") continue;
      const current = spec.nodes.find((n: { label: string; fusion?: object }) => n.label === nodeId)?.fusion ?? {};
      spec = withNodeFusion(spec, nodeId, { ...current, mode });
    }
    const fcfg = loadFusionConfig();
    const defaults = { ...fcfg.defaults, panel: fcfg.defaults.panel ?? DEMO_PANEL };
    let wf;
    try {
      wf = compile(expandFusion(spec, { defaults, tiers: loadModelTiers() }));
    } catch (e) {
      if (e instanceof FusionConfigError) return sendJson(res, 422, { error: String((e as Error).message) });
      throw e;
    }

    const piDir = join(resolved.runDir, ".pi");
    let old: { nodes?: Record<string, { status?: string }>; [k: string]: unknown } = {};
    try { old = JSON.parse(await readFile(join(piDir, "run.json"), "utf8")); } catch { /* fresh */ }
    const oldNodes = (old.nodes ?? {}) as Record<string, Record<string, unknown>>;
    const ts = new Date().toISOString();
    const runJson = {
      run: old.run ?? run, name: old.name ?? run, source: wf.meta.name,
      profile: old.profile ?? null, provider: old.provider, model: old.model ?? null,
      startedAt: old.startedAt ?? ts, updatedAt: ts,
      done: true, ok: old.ok ?? null, durationMs: old.durationMs ?? null, stage: null, totals: old.totals ?? null,
      nodes: Object.fromEntries(Object.values(wf.nodes as Record<string, { id: string; label: string; agentType?: string }>).map((n) => {
        const prev = oldNodes[n.id];
        const brand = { id: n.id, label: n.label, ...(n.agentType ? { agentType: n.agentType } : {}) };
        return [n.id, prev ? { ...prev, ...brand } : { ...brand, status: "dry", artifacts: [], issues: [] }];
      })),
    };
    await writeFile(join(piDir, "workflow.json"), JSON.stringify({ meta: wf.meta, profile: runJson.profile, stages: wf.stages, edges: wf.edges }, null, 2) + "\n");
    await writeFile(join(piDir, "run.json"), JSON.stringify(runJson, null, 2) + "\n");
    sendJson(res, 200, previewView(wf, { run }));
  } catch (e) {
    sendJson(res, 500, { error: `save-run failed for "${run}" (${String(e)})` });
  }
};

// Extensions served as binary images (rendered via <img>); everything else is served as text.
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
};
const TEXT_MIME: Record<string, string> = {
  json: "application/json; charset=utf-8", md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
};
const MAX_FILE_BYTES = 12 * 1024 * 1024;

/** `GET /__piflow/file/<run>?path=<rel|abs>` — real bytes, jailed to the run dir / workspace by realpath. */
export const piflowFile: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/file\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);
  const reqPath = new URL(req.url!, "http://localhost").searchParams.get("path");
  if (!reqPath) return sendJson(res, 400, { error: "missing ?path" });

  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
  const { runDir, workspaceRoot } = resolved;

  // resolve under the run dir first, then the workspace root; the realpath must stay inside one of them.
  const bases = [runDir, ...(workspaceRoot ? [workspaceRoot] : [])];
  const realBases: string[] = [];
  for (const b of bases) { try { realBases.push(await realpath(b)); } catch { /* skip */ } }
  const candidates = isAbsolute(reqPath) ? [reqPath] : bases.map((b) => join(b, reqPath));
  let real: string | null = null;
  for (const c of candidates) {
    let rp: string;
    try { rp = await realpath(c); } catch { continue; }
    if (realBases.some((rb) => rp === rb || rp.startsWith(rb + sep))) { real = rp; break; }
  }
  if (!real) return sendJson(res, 404, { error: `not found or outside workspace: ${reqPath}` });

  let st;
  try { st = await stat(real); } catch { return sendJson(res, 404, { error: "stat failed" }); }
  if (!st.isFile()) return sendJson(res, 400, { error: "not a file" });
  if (st.size > MAX_FILE_BYTES) return sendJson(res, 413, { error: `file too large (${st.size} bytes)` });

  const ext = (real.split(/[./]/).pop() || "").toLowerCase();
  const mime = IMAGE_MIME[ext] ?? TEXT_MIME[ext] ?? "text/plain; charset=utf-8";
  try {
    const buf = await readFile(real);
    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "no-cache");
    res.end(buf);
  } catch (e) {
    sendJson(res, 500, { error: `read failed (${String(e)})` });
  }
};

/** `GET /__piflow/tree/<run>` — the run dir's on-disk file tree (DirEntry[]). */
export const piflowTree: Middleware = async (req, res, next) => {
  const SKIP = new Set([".pi", "node_modules", ".git", ".DS_Store"]);
  const MAX_ENTRIES = 5000;
  const ext = (name: string) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : undefined; };

  const m = req.url?.match(/^\/__piflow\/tree\/([^/?]+)/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);
  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });

  let count = 0;
  type Entry = { id: string; name: string; kind: "folder" | "file"; typeLabel?: string; children?: Entry[] };
  const walk = async (absDir: string, rel: string, depth: number): Promise<Entry[]> => {
    if (depth > 12 || count >= MAX_ENTRIES) return [];
    let ents;
    try { ents = await readdir(absDir, { withFileTypes: true }); } catch { return []; }
    const dirs: Entry[] = [], files: Entry[] = [];
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name) || count >= MAX_ENTRIES) continue;
      count += 1;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) dirs.push({ id: `d:${childRel}`, name: e.name, kind: "folder", children: await walk(join(absDir, e.name), childRel, depth + 1) });
      else if (e.isFile()) files.push({ id: `f:${childRel}`, name: e.name, kind: "file", typeLabel: ext(e.name) });
    }
    return [...dirs, ...files]; // folders first, each already alpha-sorted
  };

  try {
    const tree = await walk(resolved.runDir, "", 0);
    sendJson(res, 200, { tree, truncated: count >= MAX_ENTRIES });
  } catch (e) {
    sendJson(res, 500, { error: `tree build failed for "${run}" (${String(e)})` });
  }
};

/** `POST /__piflow/checkpoint/<run>` — dumb courier: write a human's reply to the run's checkpoint file. */
export const piflowCheckpointReply: Middleware = async (req, res, next) => {
  const m = req.url?.match(/^\/__piflow\/checkpoint\/([^/?]+)/);
  if (!m) return next();
  if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to write a checkpoint reply" });
  const run = decodeURIComponent(m[1]);

  let body: { nodeId?: unknown; hash?: unknown; value?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON { nodeId, hash, value }" });
  }

  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });

  const lib = findLib("checkpoint-reply.mjs");
  if (!lib) return sendJson(res, 500, { error: "checkpoint-reply lib not found — is this the piflow gui?" });
  try {
    const { writeCheckpointReply } = await import(pathToFileURL(lib).href);
    const out = await writeCheckpointReply(resolved.runDir, body, "gui");
    return sendJson(res, out.status, out.body);
  } catch (e) {
    return sendJson(res, 500, { error: `failed to write reply (${String(e)})` });
  }
};

/** `GET /__piflow/agents.json` — the global agent-preset catalog (icons/colors) via core loadAgentPreset. */
export const piflowAgents: Middleware = async (req, res, next) => {
  if (!req.url?.match(/^\/__piflow\/agents\.json(?:\?.*)?$/)) return next();
  const mod = findCore("workflow/agent-preset.js");
  if (!mod) return sendJson(res, 500, { error: "@piflow/core agent-preset dist not found — run: npm run build (at repo root)" });
  try {
    const { defaultAgentsDir, loadAgentPreset } = await import(pathToFileURL(mod).href);
    const dir = defaultAgentsDir();
    const catalog: Record<string, { label?: string; icon?: string; color?: string }> = {};
    let files: string[] = [];
    try { files = (await readdir(dir)).filter((f) => f.endsWith(".md")); } catch { /* no catalog yet ⇒ {} */ }
    for (const f of files) {
      const preset = loadAgentPreset(f.slice(0, -3), dir);
      if (preset) catalog[preset.id] = preset.display ?? {};
    }
    sendJson(res, 200, catalog);
  } catch (e) {
    sendJson(res, 500, { error: `agents catalog build failed (${String(e)})` });
  }
};

// Load the pure node-writeback host lib ONCE, injecting core's real nodeSchema + validator (memoized).
let _writebackLib: { mod: Record<string, unknown>; validate: ((s: object, d: unknown) => { ok: boolean; errors: string[] }) | null } | null = null;
const loadWritebackLib = async () => {
  if (_writebackLib) return _writebackLib;
  const libPath = findLib("node-writeback.mjs");
  const schemaPath = findCore("workflow/template/schema/node.schema.js");
  const valPath = findCore("runner/schema.js");
  if (!libPath) throw new Error("node-writeback lib not found — is this the piflow gui?");
  if (!schemaPath || !valPath) throw new Error("@piflow/core dist not found — run: npm run build (at repo root)");
  const mod = await import(pathToFileURL(libPath).href);
  const { nodeSchema } = await import(pathToFileURL(schemaPath).href);
  const { defaultSchemaValidator } = await import(pathToFileURL(valPath).href);
  (mod.setNodeSchema as (s: unknown) => void)(nodeSchema);
  _writebackLib = { mod, validate: await defaultSchemaValidator() };
  return _writebackLib;
};

// Resolve the TEMPLATE dir for a run (the canonical sibling: runDir = <wf>/runs/<id> ⇒ <wf>/template).
type TemplateResolution = { ok: true; templateDir: string } | { ok: false; status: number; error: string };
const templateDirFor = async (run: string): Promise<TemplateResolution> => {
  const resolved = await resolveRunDir(run);
  if (!resolved) return { ok: false, status: 404, error: `no run "${run}" found — is its repo registered?` };
  const templateDir = join(resolved.runDir, "..", "..", "template");
  if (!existsSync(templateDir)) return { ok: false, status: 404, error: `no template for "${run}" at ${templateDir} (write-back needs the canonical <wf>/template layout)` };
  return { ok: true, templateDir };
};

/** `GET /node-config/<run>?node=<id>` (read authored config) + `POST /node-edit/<run>` (drop a gate chip). */
export const piflowNodeWriteback: Middleware = async (req, res, next) => {
  // ---- GET /node-config/<run>?node=<id> : the badge's authored-config read ----
  const mGet = req.url?.match(/^\/__piflow\/node-config\/([^/?]+)/);
  if (mGet) {
    const run = decodeURIComponent(mGet[1]);
    const nodeId = new URL(req.url!, "http://localhost").searchParams.get("node");
    if (!nodeId) return sendJson(res, 400, { error: "missing ?node=<id>" });
    const tpl = await templateDirFor(run);
    if (!tpl.ok) return sendJson(res, tpl.status, { error: tpl.error });
    try {
      const { mod } = await loadWritebackLib();
      const node = await (mod.readNodeConfig as (d: string, id: string) => Promise<unknown>)(tpl.templateDir, nodeId);
      return sendJson(res, 200, { node });
    } catch (e) {
      return sendJson(res, 404, { error: String((e as Error)?.message ?? e) });
    }
  }

  // ---- POST /node-edit/<run> : drop a gate chip → mutate the template node.json ----
  const mPost = req.url?.match(/^\/__piflow\/node-edit\/([^/?]+)/);
  if (!mPost) return next();
  if ((req.method || "GET").toUpperCase() !== "POST") return sendJson(res, 405, { error: "use POST to edit a node" });
  const run = decodeURIComponent(mPost[1]);

  let body: { nodeId?: unknown; chip?: unknown; target?: unknown };
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "body must be JSON { nodeId, chip, target? }" });
  }
  const nodeId = typeof body.nodeId === "string" ? body.nodeId : "";
  const target = body.target === "run" ? "run" : "template";

  if (target === "run") {
    return sendJson(res, 501, { error: "run-instance (ephemeral) edits are not implemented yet — only template edits are durable; live mid-run mutation is deferred", stub: true });
  }

  const tpl = await templateDirFor(run);
  if (!tpl.ok) return sendJson(res, tpl.status, { error: tpl.error });

  try {
    const { mod, validate } = await loadWritebackLib();
    const out = await (mod.writeNodeEdit as (d: string, id: string, e: unknown, v: unknown) => Promise<{ status: number; body: unknown }>)(
      tpl.templateDir,
      nodeId,
      { chip: body.chip },
      validate,
    );
    return sendJson(res, out.status, out.body);
  } catch (e) {
    return sendJson(res, 500, { error: `node edit failed (${String(e)})` });
  }
};

/** `POST/GET /__piflow/control/<run>/{start,stream,message,sessions,select,new}` — the two-way `pi --mode rpc` console. */
export const piflowControlSession: Middleware = async (req, res, next) => {
  const loadHost = async () => {
    const lib = findLib("control-session.mjs");
    if (!lib) return null;
    return import(pathToFileURL(lib).href);
  };

  const m = req.url?.match(/^\/__piflow\/control\/([^/?]+)\/(start|stream|message|sessions|select|new)(?:\?.*)?$/);
  if (!m) return next();
  const run = decodeURIComponent(m[1]);
  const action = m[2];

  const host = await loadHost();
  if (!host) return sendJson(res, 500, { error: "control-session lib not found — is this the piflow gui?" });

  // ---- POST /start: spawn (or reuse) the control pi at cwd=runDir, inheriting pi config ----
  if (action === "start") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to start a control session" });
    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    try {
      const handle = host.startSession(run, resolved.runDir);
      return sendJson(res, 202, handle);
    } catch (e) {
      return sendJson(res, 500, { error: `failed to start control session (${String(e)})` });
    }
  }

  // ---- GET /stream: SSE relay of the control pi's frames ----
  if (action === "stream") {
    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    try { host.startSession(run, resolved.runDir); } catch (e) { return sendJson(res, 500, { error: `failed to start control session (${String(e)})` }); }

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch { /* socket gone */ } }, 15000);
    const write = (frame: unknown) => { try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch { /* socket gone */ } };

    let unsub: (() => void) | null = null;
    try { unsub = host.subscribe(run, write); } catch (e) { write({ v: 1, type: "stream-error", error: String(e) }); }

    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(ping); unsub?.(); };
    req.on("close", cleanup);
    res.on("close", cleanup);
    write({ v: 1, type: "meta", run, runDir: resolved.runDir });
    return; // SSE stays open
  }

  // ---- POST /message: dumb courier → one RPC command to the child's stdin ----
  if (action === "message") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to send a control message" });
    let body: { text?: unknown; deliverAs?: unknown; type?: unknown; [k: string]: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "body must be JSON { text, deliverAs? } or a raw RPC command { type, … }" });
    }
    let cmd: Record<string, unknown>;
    if (typeof body.text === "string") {
      const deliver = body.deliverAs === "steer" || body.deliverAs === "followUp" ? body.deliverAs : undefined;
      const type = deliver === "steer" ? "steer" : deliver === "followUp" ? "follow_up" : "prompt";
      cmd = { ...body, type, message: body.text };
      delete cmd.text;
      delete cmd.deliverAs;
    } else if (typeof body.type === "string") {
      cmd = body as Record<string, unknown>;
    } else {
      return sendJson(res, 400, { error: "send { text } for a chat message, or { type } for a control verb" });
    }
    const out = host.sendCommand(run, cmd);
    return sendJson(res, out.status, out.body);
  }

  // ---- GET /sessions: the conversation HISTORY list ----
  if (action === "sessions") {
    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    try {
      const list = await host.listSessions(run, resolved.runDir);
      return sendJson(res, 200, { sessions: list });
    } catch (e) {
      return sendJson(res, 500, { error: `failed to list sessions (${String(e)})` });
    }
  }

  // ---- POST /select: CONTINUE an existing conversation ----
  if (action === "select") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to select a conversation" });
    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    let body: { sessionId?: unknown };
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "body must be JSON { sessionId }" }); }
    if (typeof body.sessionId !== "string") return sendJson(res, 400, { error: "sessionId (string) required" });
    try {
      const out = await host.selectSession(run, resolved.runDir, body.sessionId);
      return sendJson(res, out.status, out.body);
    } catch (e) {
      return sendJson(res, 500, { error: `select failed (${String(e)})` });
    }
  }

  // ---- POST /new: start a FRESH conversation ----
  if (action === "new") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to start a new conversation" });
    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    try {
      const out = await host.newChat(run, resolved.runDir);
      return sendJson(res, out.status, out.body);
    } catch (e) {
      return sendJson(res, 500, { error: `new chat failed (${String(e)})` });
    }
  }

  return next();
};

/** Every control-API handler, in match order. `piflowStartRun` (POST /api/runs/start) leads so the launch
 *  path is matched first; the rest are the read/observe/control surface lifted from the Vite middleware. */
export const apiHandlers: Middleware[] = [
  piflowStartRun,
  piflowMigrate,
  piflowContexts,
  piflowMigrateStatus,
  piflowMigrateRun,
  piflowGlobalIndex,
  piflowRunStream,
  piflowRunView,
  piflowRunDigest,
  piflowPreview,
  piflowSaveRun,
  piflowFile,
  piflowTree,
  piflowCheckpointReply,
  piflowAgents,
  piflowNodeWriteback,
  piflowControlSession,
];

/** Chain a list of (req,res,next) middlewares: each `next()` tries the following one; unmatched → finalNext. */
export function chain(handlers: Middleware[]): Middleware {
  return (req, res, finalNext) => {
    let i = 0;
    const next: Next = () => {
      const h = handlers[i++];
      if (!h) return finalNext();
      Promise.resolve(h(req, res, next)).catch((e) => {
        try { sendJson(res, 500, { error: `handler error (${String(e)})` }); } catch { /* already sent */ }
      });
    };
    next();
  };
}

/** The composed control-API middleware (all handlers, in order). `extra` handlers run FIRST (e.g. start-run).
 *  `allowedTemplates` (when set) binds the start-run template allow-list; omitted ⇒ the default (allow-all)
 *  `piflowStartRun` from `apiHandlers`, preserving today's local behavior for the GUI's Vite middleware. */
export function createApiMiddleware(extra: Middleware[] = [], allowedTemplates?: string[] | null): Middleware {
  const handlers = allowedTemplates?.length
    ? apiHandlers.map((h) =>
        h === piflowStartRun ? makePiflowStartRun(allowedTemplates)
        : h === piflowMigrate ? makePiflowMigrate(allowedTemplates) // adopt spawns a runner — same allow-list
        : h,
      )
    : apiHandlers;
  return chain([...extra, ...handlers]);
}

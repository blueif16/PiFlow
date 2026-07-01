import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile, readdir, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, isAbsolute, sep } from "node:path";
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

/** Resolve a run id → its run dir + the owning product's workspace root, from the LIVE index (so a run
 *  added since launch resolves). Shared by the stream/run-view/file endpoints' lookups. */
async function resolveRunDir(run: string): Promise<{ runDir: string; workspaceRoot: string | null } | null> {
  const lib = findUp("scripts/lib/index-snapshot.mjs");
  if (!lib) return null;
  try {
    const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
    const ix = await buildSnapshot(loadScopedRegistry());
    for (const p of ix.products ?? [])
      for (const ns of p.namespaces ?? []) {
        const hit = (ns.threads ?? []).find((t: { run?: string; runDir?: string }) => t.run === run && t.runDir);
        if (hit) return { runDir: hit.runDir, workspaceRoot: p.root ?? null };
      }
  } catch { /* fall through */ }
  return null;
}

/**
 * Serve the piflow index/products to the GUI — WITHOUT copying collected data into the repo (the data/SDK
 * boundary rule: no index.json under gui/public). `/__piflow/index.json` is LIVE: it recomputes the snapshot
 * on EVERY request via the shared builder (gui/scripts/lib/index-snapshot.mjs) from the SCOPED registry
 * (`loadScopedRegistry` — the `PIFLOW_GUI_ROOTS` set `piflowctl gui` passes for the launched project, else the
 * global `~/.piflow/products.json`), so a run that starts or progresses after the server launched shows up
 * without a manual `npm run data:index`. `/__piflow/products.json` returns that same scoped registry.
 */
function piflowGlobalIndex(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/(index|products)\.json(?:\?.*)?$/);
    if (!m) return next();
    const lib = findUp("scripts/lib/index-snapshot.mjs");
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
        const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
        const ix = await buildSnapshot(loadScopedRegistry());
        for (const p of ix.products ?? [])
          for (const ns of p.namespaces ?? [])
            for (const t of ns.threads ?? [])
              if (t.run === run && t.runDir) runDir = t.runDir;
      } catch { /* fall through to 404 */ }
    }
    if (!runDir) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered? (piflowctl gui / npm run data:index)` });

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

/**
 * On-demand RUN-VIEW — `GET /__piflow/run-view/<run>` distills a run's REAL `.pi/` tree (run.json +
 * per-node events.jsonl + io.json) into the enriched run-view the canvas/HUD render, via the SHARED
 * `@piflow/core/observe` `buildRunView` (NOT a GUI-local copy — the data layer lives in the package, so
 * GUI + TUI + CLI agree). This is the ONE path for EVERY run — live, historical, or foreign — replacing
 * the old transcode-to-gui/public/run-view.json step (no run data is copied into the repo). The run dir,
 * its sibling runs (the prior-run average), and the workspace root are resolved from the SAME live index.
 */
function piflowRunView(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/run-view\/([^/?]+)/);
    if (!m) return next();
    const run = decodeURIComponent(m[1]);

    let runDir: string | null = null;
    let workspaceRoot: string | null = null;
    const historyDirs: string[] = [];
    const lib = findUp("scripts/lib/index-snapshot.mjs");
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

    const obs = findUp("packages/core/dist/observe/index.js");
    if (!obs) return sendJson(res, 500, { error: "@piflow/core observe dist not found — run: npm run build (at repo root)" });
    try {
      const { buildRunView } = await import(pathToFileURL(obs).href);
      const { view } = buildRunView(runDir, { historyDirs, workspaceRoot });
      sendJson(res, 200, view);
    } catch (e) {
      sendJson(res, 500, { error: `run-view build failed for "${run}" (${String(e)})` });
    }
  };
  return {
    name: "piflow-run-view",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * On-demand FUSION/STRUCTURE PREVIEW — `GET /__piflow/preview/<run>?overrides=<json>` re-compiles the
 * run's TEMPLATE with per-node fusion activations TOGGLED ON and returns the resulting DAG in the SAME
 * run-view contract the canvas renders. This is what powers the GUI's "fusion mode": the siblings+judge
 * expansion is the SDK's OWN transform (`loadTemplate → withNodeFusion → expandFusion → compile →
 * previewView` — the exact chain the CLI `run --dry-run` uses), NEVER a view-local DAG rewrite. `overrides`
 * is `{ "<nodeId>": "moa" | "best-of-n" }`; the chosen mode is merged over any authored fusion params, and
 * everything else resolves through the SDK's fusion defaults (`~/.piflow/fusion.json`) + a demo-panel
 * fallback so a moa toggle never errors with no config. The template is the run's canonical sibling
 * `<wf>/template/` (runDir = `<wf>/runs/<id>`). NOTE: it re-compiles the raw template (no profile applied),
 * so for an unprofiled run the no-override structure matches the run-view exactly.
 */
function piflowPreview(): Plugin {
  // A moa panel is REQUIRED; when neither the node nor ~/.piflow/fusion.json supplies one, the preview
  // falls back to these tiers (resolved like any tier alias) so the toggle is demoable with zero config.
  const DEMO_PANEL = ["fast", "balanced", "deep"];
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const m = req.url?.match(/^\/__piflow\/preview\/([^/?]+)/);
    if (!m) return next();
    const run = decodeURIComponent(m[1]);

    const resolved = await resolveRunDir(run);
    if (!resolved) return sendJson(res, 404, { error: `no run "${run}" found — is its repo registered?` });
    // The template is the run's canonical sibling: runDir = <wf>/runs/<id> ⇒ template = <wf>/template.
    const templateDir = join(resolved.runDir, "..", "..", "template");
    if (!existsSync(templateDir)) return sendJson(res, 404, { error: `no template for "${run}" at ${templateDir} (preview needs the canonical <wf>/template layout)` });

    let overrides: Record<string, string> = {};
    const raw = new URL(req.url!, "http://localhost").searchParams.get("overrides");
    if (raw) { try { overrides = JSON.parse(raw); } catch { return sendJson(res, 400, { error: "overrides must be JSON" }); } }

    const core = findUp("packages/core/dist/index.js");
    const obs = findUp("packages/core/dist/observe/index.js");
    if (!core || !obs) return sendJson(res, 500, { error: "@piflow/core dist not found — run: npm run build (at repo root)" });
    try {
      const { loadTemplate, withNodeFusion, expandFusion, compile, loadFusionConfig, loadModelTiers, FusionConfigError } = await import(pathToFileURL(core).href);
      const { previewView } = await import(pathToFileURL(obs).href);

      let spec = await loadTemplate(templateDir);
      // Toggle each requested node ON, merging the chosen mode over any authored fusion params.
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
  return {
    name: "piflow-preview",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * SAVE A FUSION EDIT INTO THE RUN — `POST /__piflow/save-run/<run>?overrides=<json>` BAKES the previewed
 * fusion structure into THIS run (NOT the template): it re-compiles the same SDK chain `/preview` uses, then
 * persists `.pi/workflow.json` (the new resolved stages+edges) + `.pi/run.json` so the run's PERMANENT shape
 * becomes the edited one. The mental model is "everything you see is a run, so an edit restructures this run."
 * It is non-destructive to results: a node id that already existed keeps its prior status/artifacts; only the
 * NEW siblings+judge are `dry` (planned, not run). Returns the new view so the canvas updates immediately.
 */
function piflowSaveRun(): Plugin {
  const DEMO_PANEL = ["fast", "balanced", "deep"];
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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

    const core = findUp("packages/core/dist/index.js");
    const obs = findUp("packages/core/dist/observe/index.js");
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

      // Merge into the run's existing status: unchanged ids keep their record (real results survive); the
      // brand-new siblings/judge are `dry`. workflow.json is rewritten to the new resolved DAG.
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
  return {
    name: "piflow-save-run",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * On-demand FILE READ-BACK — `GET /__piflow/file/<run>?path=<rel|abs>` serves a file's REAL bytes from
 * disk so the HUD renders ANY file it has a path for (input read, output artifact, or write) — markdown,
 * json, code, or image — not just the 8 KB telemetry snapshot. The run-view records paths only; this is
 * the missing filesystem bridge. Resolution: the path is taken under the run dir (the run's own copy)
 * then the workspace root, and the REALPATH must stay inside one of them (no `..`/symlink escape). Images
 * are served with an image MIME for `<img>`; everything else as UTF-8 text for the reader. Dev + preview.
 */
function piflowFile(): Plugin {
  // Extensions served as binary images (rendered via <img>); everything else is served as text.
  const IMAGE_MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  };
  const TEXT_MIME: Record<string, string> = {
    json: "application/json; charset=utf-8", md: "text/markdown; charset=utf-8", markdown: "text/markdown; charset=utf-8",
  };
  const MAX_FILE_BYTES = 12 * 1024 * 1024;

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
  return {
    name: "piflow-file",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * On-demand RUN FILE TREE — `GET /__piflow/tree/<run>` walks the run's `{{RUN}}` folder (= runDir) and
 * returns the FULL on-disk file tree as DirEntry[] (`{id,name,kind,typeLabel?,children?}`), rooted at the
 * run dir. Unlike the run-view's produced-files list, this is the real filesystem — every file the run
 * holds, browsable in the top-left navigator. Internal/noise dirs (`.pi` telemetry, `node_modules`, `.git`)
 * are skipped. File ids are `f:<run-relative path>` (folders `d:<…>`) so a leaf's id maps 1:1 onto the
 * run-relative displayPath the run-view emits (→ click opens the producing node when there is one).
 */
function piflowTree(): Plugin {
  const SKIP = new Set([".pi", "node_modules", ".git", ".DS_Store"]);
  const MAX_ENTRIES = 5000;
  const ext = (name: string) => { const i = name.lastIndexOf("."); return i > 0 ? name.slice(i + 1).toLowerCase() : undefined; };

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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
  return {
    name: "piflow-tree",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * (G5 — HITL) The reply COURIER — `POST /__piflow/checkpoint/<run>` writes a human's answer to a paused
 * checkpoint into the run dir, the SAME file the runner watches (`.pi/checkpoints/<nodeId>.reply.json`).
 * It is a DUMB courier: it does ZERO semantic validation (the RUNNER is the sole authority — it re-validates
 * the echoed hash + kind/choices/shape before acting, and ignores a bad/stale reply). It only checks the run
 * exists and `nodeId` is a safe slug (no `/`/`..` escape — the write stays inside `.pi/checkpoints/`). The
 * run dir is resolved from the SAME live `~/.piflow` index the GETs use (no baked path — the data/SDK
 * boundary). Returns 202 immediately; the runner picks the reply up on its next poll. Dev + preview only.
 *
 * Body: `{ nodeId: string, hash: string, value: unknown }`. Writes `{ nodeId, hash, value, by:"gui", at }`.
 * The console/TUI resolve the SAME checkpoint by writing the SAME file directly — couriers are interchangeable.
 */
function piflowCheckpointReply(): Plugin {
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      let tooBig = false;
      req.on("data", (c) => {
        data += c;
        if (data.length > 1_000_000) { tooBig = true; req.destroy(); } // 1 MB cap — a reply is tiny
      });
      req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(data)));
      req.on("error", reject);
    });

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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

    // The slug-containment + write are the factored pure core (gui/scripts/lib/checkpoint-reply.mjs) so the
    // contract is unit-testable without Vite. The courier does NO semantic validation — the RUNNER re-validates
    // the echoed hash + kind/choices/shape and ignores a bad/stale reply. Resolve the lib by ABSOLUTE path the
    // same way the GETs resolve the index lib (esbuild never bundles it into the config).
    const lib = findUp("scripts/lib/checkpoint-reply.mjs");
    if (!lib) return sendJson(res, 500, { error: "checkpoint-reply lib not found — is this the piflow gui?" });
    try {
      const { writeCheckpointReply } = await import(pathToFileURL(lib).href);
      const out = await writeCheckpointReply(resolved.runDir, body, "gui");
      return sendJson(res, out.status, out.body);
    } catch (e) {
      return sendJson(res, 500, { error: `failed to write reply (${String(e)})` });
    }
  };

  return {
    name: "piflow-checkpoint-reply",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * (G6) AGENT-PRESET catalog — `GET /__piflow/agents.json` returns `{ [id]: { label, icon, color } }` read
 * from the GLOBAL catalog `~/.piflow/agents/*.md` via the SHARED core parser (`@piflow/core`
 * `loadAgentPreset` — NOT a GUI-local copy, same boundary rule as the run-view). The GUI keys a node's
 * preset icon off `RunViewNode.agentType` → this map; the node carries only the label string, the display
 * lives here (decision #3). No preset data is committed into the repo. Absent catalog ⇒ `{}` (the node
 * renders the default chip — the icon is cosmetic and never blocks a view).
 */
function piflowAgents(): Plugin {
  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.match(/^\/__piflow\/agents\.json(?:\?.*)?$/)) return next();
    const mod = findUp("packages/core/dist/workflow/agent-preset.js");
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
  return {
    name: "piflow-agents",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * (SA-E) GUI WRITE-BACK — the drag-to-compose editor's spine. Config is the SINGLE SOURCE OF TRUTH:
 * every GUI edit is a mutation to the per-repo TEMPLATE `node.json` the run reads, NOT GUI-local state
 * and NEVER the GUI bundle or a `~/.piflow` snapshot (the data-boundary rule). Two endpoints, mirroring
 * the existing idioms:
 *   - `GET  /__piflow/node-config/<run>?node=<id>` → the node's AUTHORED config from the TEMPLATE
 *     `node.json` (the badge's gate-pipeline/tier/loadout source — the run-view distillation does NOT
 *     carry the template `op[]`, so the badge reads the authored file directly). Read path the write
 *     path mirrors.
 *   - `POST /__piflow/node-edit/<run>`  `{ nodeId, chip, target? }` → drop a GATE chip onto a node:
 *     appends its gate to the node's `op[]` lane (or the G5 `checkpoint` field for a human gate), VALIDATES
 *     the result against core's `nodeSchema` (the SAME gate `loadTemplate` runs), then ATOMICALLY writes
 *     `<wf>/template/nodes/<id>/node.json`. A malformed edit is rejected (400) and NOTHING is written.
 *
 * `target` (default `"template"`) selects the durable TEMPLATE write (implemented). `target:"run"` (the
 * ephemeral per-run edit) is a CLEARLY-MARKED STUB (501) — and live mid-run mutation is DEFERRED entirely
 * (worker-types.md §"Edit target"). The run dir → template dir resolution is `<wf>/runs/<id>` ⇒
 * `<wf>/template`, the SAME canonical-sibling layout `/preview` + `/save-run` use. The op[]-mutation logic
 * is the PURE, unit-tested host lib (gui/scripts/lib/node-writeback.mjs) — this plugin is a thin courier
 * (route match, run resolution, body read), like `piflowCheckpointReply`. The lib is loaded by ABSOLUTE
 * path (esbuild never bundles it into this config), and core's `nodeSchema` + ajv validator are injected
 * from the built dist — the exact pair `loadTemplate` validates with. Dev + preview only.
 */
function piflowNodeWriteback(): Plugin {
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      let tooBig = false;
      req.on("data", (c) => {
        data += c;
        if (data.length > 1_000_000) { tooBig = true; req.destroy(); } // 1 MB cap — a node edit is tiny
      });
      req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(data)));
      req.on("error", reject);
    });

  // Resolve the TEMPLATE dir for a run (the canonical sibling: runDir = <wf>/runs/<id> ⇒ <wf>/template).
  type TemplateResolution = { ok: true; templateDir: string } | { ok: false; status: number; error: string };
  const templateDirFor = async (run: string): Promise<TemplateResolution> => {
    const resolved = await resolveRunDir(run);
    if (!resolved) return { ok: false, status: 404, error: `no run "${run}" found — is its repo registered?` };
    const templateDir = join(resolved.runDir, "..", "..", "template");
    if (!existsSync(templateDir)) return { ok: false, status: 404, error: `no template for "${run}" at ${templateDir} (write-back needs the canonical <wf>/template layout)` };
    return { ok: true, templateDir };
  };

  // Load the pure host lib (op[] mutation + safety) ONCE, injecting core's real nodeSchema so the
  // write-back validates with the exact gate loadTemplate uses. Memoized across requests.
  let _lib: { mod: Record<string, unknown>; validate: ((s: object, d: unknown) => { ok: boolean; errors: string[] }) | null } | null = null;
  const loadLib = async () => {
    if (_lib) return _lib;
    const libPath = findUp("scripts/lib/node-writeback.mjs");
    const schemaPath = findUp("packages/core/dist/workflow/template/schema/node.schema.js");
    const valPath = findUp("packages/core/dist/runner/schema.js");
    if (!libPath) throw new Error("node-writeback lib not found — is this the piflow gui?");
    if (!schemaPath || !valPath) throw new Error("@piflow/core dist not found — run: npm run build (at repo root)");
    const mod = await import(pathToFileURL(libPath).href);
    const { nodeSchema } = await import(pathToFileURL(schemaPath).href);
    const { defaultSchemaValidator } = await import(pathToFileURL(valPath).href);
    (mod.setNodeSchema as (s: unknown) => void)(nodeSchema);
    _lib = { mod, validate: await defaultSchemaValidator() };
    return _lib;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    // ---- GET /node-config/<run>?node=<id> : the badge's authored-config read ----
    const mGet = req.url?.match(/^\/__piflow\/node-config\/([^/?]+)/);
    if (mGet) {
      const run = decodeURIComponent(mGet[1]);
      const nodeId = new URL(req.url!, "http://localhost").searchParams.get("node");
      if (!nodeId) return sendJson(res, 400, { error: "missing ?node=<id>" });
      const tpl = await templateDirFor(run);
      if (!tpl.ok) return sendJson(res, tpl.status, { error: tpl.error });
      try {
        const { mod } = await loadLib();
        const node = await (mod.readNodeConfig as (d: string, id: string) => Promise<unknown>)(tpl.templateDir, nodeId);
        return sendJson(res, 200, { node });
      } catch (e) {
        // readNodeConfig throws WritebackError for a missing/unparseable node.json → 404.
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

    // run-target (ephemeral per-run edit) is a CLEARLY-MARKED STUB; live mid-run mutation is DEFERRED.
    if (target === "run") {
      return sendJson(res, 501, { error: "run-instance (ephemeral) edits are not implemented yet — only template edits are durable; live mid-run mutation is deferred", stub: true });
    }

    const tpl = await templateDirFor(run);
    if (!tpl.ok) return sendJson(res, tpl.status, { error: tpl.error });

    try {
      const { mod, validate } = await loadLib();
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

  return {
    name: "piflow-node-writeback",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * CONTROL SESSION — the ONE two-way channel: talk to an interactive `pi` about a run. Endpoints mirror the
 * existing idioms, all SEPARATE from the one-way DAG telemetry (`/__piflow/stream/<run>`, which is unchanged)
 * so that feed stays pure one-way:
 *   - `POST /__piflow/control/<run>/start`   → spawn (or reuse) `pi --mode rpc` at cwd=runDir; 202 + handle.
 *   - `GET  /__piflow/control/<run>/stream`  → SSE of the pi's frames (events + id-correlated responses);
 *     subscribing triggers the snapshot (get_state/get_messages/get_session_stats). Like `piflowRunStream`.
 *   - `POST /__piflow/control/<run>/message` → dumb courier forwarding one RPC command to the child's stdin
 *     (prompt/steer/follow_up/abort/set_model/…). Like `piflowCheckpointReply`.
 *   - `GET  /__piflow/control/<run>/sessions` → the CONVERSATION HISTORY list (header-parse of the run's
 *     `.pi-control/*.jsonl`); `[{id,name,firstMessage,mtime,active}]`. The list IS the navigation.
 *   - `POST /__piflow/control/<run>/select`  `{sessionId}` → CONTINUE that conversation (switch_session live /
 *     respawn `--session <id>` dead).
 *   - `POST /__piflow/control/<run>/new`     → start a FRESH conversation (new_session live / fresh spawn dead).
 * Each conversation is one of pi's OWN session files under `--session-dir <runDir>/.pi-control` (no hand-rolled
 * persistence). The spawn/framing/session-machinery live in the PURE host lib (control-session.mjs).
 * The spawn/framing live in the PURE host lib (gui/scripts/lib/control-session.mjs), loaded by ABSOLUTE path
 * the same way the index/checkpoint libs are (esbuild never bundles it into this config). The control pi runs
 * `--mode rpc`; piflow's DAG nodes run `--mode json` — separate builders, the node path is untouched here.
 */
function piflowControlSession(): Plugin {
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      let tooBig = false;
      req.on("data", (c) => {
        data += c;
        if (data.length > 1_000_000) { tooBig = true; req.destroy(); } // 1 MB cap — a chat message is small
      });
      req.on("end", () => (tooBig ? reject(new Error("body too large")) : resolve(data)));
      req.on("error", reject);
    });

  // The host lib holds the dev-server-scoped session registry; loaded ONCE so all three routes share it.
  const loadHost = async () => {
    const lib = findUp("scripts/lib/control-session.mjs");
    if (!lib) return null;
    return import(pathToFileURL(lib).href);
  };

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
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

    // ---- GET /stream: SSE relay of the control pi's frames (same machinery as piflowRunStream) ----
    if (action === "stream") {
      // Auto-start on connect so opening the stream is enough to spin the pi up (the GUI also POSTs /start,
      // but startSession is idempotent — one pi per run).
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

      // subscribe re-triggers the snapshot for THIS client (re-base on (re)connect), then live deltas flow.
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
      // Two shapes: a chat message ({text, deliverAs?}) → prompt|steer|follow_up; or a passthrough control
      // verb ({type:"abort"|"set_model"|"set_thinking_level"|"compact", …}). The runner is NOT involved —
      // this is the chat/steer/abort surface only (run-lifecycle intents are a separate, out-of-scope door).
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

    // ---- GET /sessions: the conversation HISTORY list (header-parse of <runDir>/.pi-control/*.jsonl) ----
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

    // ---- POST /select: CONTINUE an existing conversation (switch_session live / respawn --session dead) ----
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

    // ---- POST /new: start a FRESH conversation (new_session live / fresh spawn dead) ----
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

  return {
    name: "piflow-control-session",
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

export default defineConfig({
  plugins: [react(), piflowGlobalIndex(), piflowRunStream(), piflowRunView(), piflowPreview(), piflowSaveRun(), piflowFile(), piflowTree(), piflowCheckpointReply(), piflowAgents(), piflowNodeWriteback(), piflowControlSession()],
  server: { port: 5173, host: true },
});

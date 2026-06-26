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
    const { loadRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
    const ix = await buildSnapshot(loadRegistry());
    for (const p of ix.products ?? [])
      for (const ns of p.namespaces ?? []) {
        const hit = (ns.threads ?? []).find((t: { run?: string; runDir?: string }) => t.run === run && t.runDir);
        if (hit) return { runDir: hit.runDir, workspaceRoot: p.root ?? null };
      }
  } catch { /* fall through */ }
  return null;
}

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
        const { loadRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
        const ix = await buildSnapshot(loadRegistry());
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

export default defineConfig({
  plugins: [react(), piflowGlobalIndex(), piflowRunStream(), piflowRunView(), piflowPreview(), piflowSaveRun(), piflowFile(), piflowTree(), piflowCheckpointReply(), piflowAgents()],
  server: { port: 5173, host: true },
});

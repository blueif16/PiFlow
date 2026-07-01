// POST /api/runs/start — the one control-API endpoint the GUI's Vite middleware never had: LAUNCH a run
// (start agents) from the console. It resolves a template, mints the run id, spawns a DETACHED `piflowctl
// run --run <id> …` (so the run is crash-durable via its on-disk journal and survives the server dying),
// then returns 202 with the run id the moment the run is discoverable — the client then observes through the
// existing `/__piflow/stream/<run>` SSE. Executor choice (pi | claude-code, per-node or run-level) rides in
// the body straight onto the `--executor` flags, so "choose which agent runs" works from the GUI.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { generateRunName } from "@piflow/core";
import { findUp, findLib, pathToFileURL, readBody, resolveRunDir, sendJson, type Middleware } from "./resolve.js";

export interface StartBody {
  templateDir?: string;
  product?: string;
  workflow?: string;
  run?: string;
  args?: Record<string, string>;
  sandbox?: string;
  profile?: string;
  provider?: string;
  thinking?: string;
  model?: string;
  detach?: boolean;
  dryRun?: boolean;
  executor?: "pi" | "claude-code";
  executorOverride?: Record<string, "pi" | "claude-code">;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolve a request body to an absolute template dir (either `templateDir` directly, or `product`[+`workflow`]
 *  looked up in the LIVE index → its namespace's `templatePath` → the containing template dir). */
export async function resolveTemplateDir(body: StartBody): Promise<{ ok: true; templateDir: string; productRoot: string | null } | { ok: false; error: string }> {
  if (body.templateDir) {
    const dir = path.resolve(body.templateDir);
    if (!existsSync(path.join(dir, "meta.json"))) return { ok: false, error: `templateDir "${dir}" has no meta.json — not a piflow template dir` };
    return { ok: true, templateDir: dir, productRoot: null };
  }
  if (!body.product) return { ok: false, error: "provide `templateDir` (absolute) or `product` (+ optional `workflow`)" };
  const lib = findLib("index-snapshot.mjs");
  if (!lib) return { ok: false, error: "index-snapshot lib not found — is this the piflow gui/monorepo?" };
  try {
    const { loadScopedRegistry, buildSnapshot } = await import(pathToFileURL(lib).href);
    const ix = await buildSnapshot(loadScopedRegistry());
    const prod = (ix.products ?? []).find((p: { id?: string }) => p.id === body.product);
    if (!prod) return { ok: false, error: `no product "${body.product}" in scope` };
    const nss = prod.namespaces ?? [];
    const ns = body.workflow ? nss.find((n: { id?: string }) => n.id === body.workflow) : nss[0];
    if (!ns?.templatePath) return { ok: false, error: `no workflow ${body.workflow ? `"${body.workflow}" ` : ""}with a template under product "${body.product}"` };
    return { ok: true, templateDir: path.dirname(ns.templatePath), productRoot: prod.root ?? null };
  } catch (e) {
    return { ok: false, error: `index lookup failed (${String(e)})` };
  }
}

/**
 * The template allow-list gate. `POST /api/runs/start` spawns agents with credentials (RCE-by-design), so a
 * publicly-exposed control plane must restrict WHICH templates it will run. PURE (no I/O) — compares resolved
 * absolute paths so trailing slashes and relative-vs-absolute forms of the SAME dir are equal.
 * - allowlist undefined/null/empty ⇒ true (ALLOW ALL — preserves today's local dev behavior).
 * - otherwise ⇒ true iff `templateDir` (path.resolve'd) equals one of the allowlist entries (each path.resolve'd).
 */
export function isTemplateAllowed(templateDir: string, allowlist: string[] | undefined | null): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const target = path.resolve(templateDir);
  return allowlist.some((entry) => path.resolve(entry) === target);
}

/** The canonical runs home for a template dir (`.piflow/<wf>/template` ⇒ `.piflow/<wf>/runs`), else null. */
export function runsHomeFor(templateDir: string): string | null {
  return path.basename(templateDir) === "template" ? path.join(path.dirname(templateDir), "runs") : null;
}

function existingRunNames(runsHome: string | null): string[] {
  if (!runsHome) return [];
  try { return readdirSync(runsHome, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

/**
 * Build the `piflowctl run` argv from a start-run request — PURE (no I/O), so the flag mapping (executor
 * choice per-node + run-level, args, sandbox, dry-run/detach/profile/provider/thinking/model) is unit-tested
 * without spawning. The executor flags mirror the CLI parser: `--executor <v>` (run-level) and
 * `--executor <nodeId>=<v>` (per-node), which the runner's resolveExecutor honors at run start.
 */
export function buildStartRunArgv(templateDir: string, runId: string, body: StartBody): string[] {
  const argv = ["run", templateDir, "--run", runId];
  if (body.sandbox) argv.push("--sandbox", String(body.sandbox));
  if (body.dryRun) argv.push("--dry-run");
  if (body.detach) argv.push("--detach");
  if (body.profile) argv.push("--profile", String(body.profile));
  if (body.provider) argv.push("--provider", String(body.provider));
  if (body.thinking) argv.push("--thinking", String(body.thinking));
  if (body.model) argv.push("--model", String(body.model));
  if (body.executor) argv.push("--executor", body.executor);
  for (const [nodeId, v] of Object.entries(body.executorOverride ?? {})) argv.push("--executor", `${nodeId}=${v}`);
  for (const [k, v] of Object.entries(body.args ?? {})) argv.push("--arg", `${k}=${v}`);
  return argv;
}

/**
 * POST /api/runs/start, bound to an optional template allow-list. `allowedTemplates` undefined/null/empty ⇒
 * ALLOW ALL (today's local behavior); when set, a request resolving to a non-listed templateDir is rejected
 * with 403 BEFORE the runner is spawned. Factory (not a bare const) so the CLI can thread the allow-list in.
 */
export function makePiflowStartRun(allowedTemplates?: string[] | null): Middleware {
  return async (req, res, next) => {
    if (!req.url?.match(/^\/api\/runs\/start(?:\?.*)?$/)) return next();
    if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to start a run" });

    let body: StartBody;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "body must be JSON" }); }

    const tpl = await resolveTemplateDir(body);
    if (!tpl.ok) return sendJson(res, 400, { error: tpl.error });

    // The credentialed launch is RCE-by-design; on a hardened host only allow-listed templates may run.
    if (!isTemplateAllowed(tpl.templateDir, allowedTemplates)) return sendJson(res, 403, { error: "template not allowed" });

    const runsHome = runsHomeFor(tpl.templateDir);
    const runId = (typeof body.run === "string" && body.run.trim()) ? body.run.trim() : generateRunName(existingRunNames(runsHome));

    // The detached `piflowctl run` argv (PURE builder, unit-tested). The run's canonical home derives from the
    // templateDir (not cwd), so the run lands under .piflow/<wf>/runs/<runId> regardless of where the server runs.
    const argv = buildStartRunArgv(tpl.templateDir, runId, body);

    const cliBin = findUp("packages/cli/dist/cli.js");
    const cwd = tpl.productRoot ?? process.cwd();
    try {
      const child = cliBin
        ? spawn(process.execPath, [cliBin, ...argv], { cwd, detached: true, stdio: "ignore" })
        : spawn("piflowctl", argv, { cwd, detached: true, stdio: "ignore" });
      child.on("error", (e) => { process.stderr.write(`start-run: failed to spawn the runner (${String(e)})\n`); });
      child.unref();
    } catch (e) {
      return sendJson(res, 500, { error: `failed to launch the run (${String(e)})` });
    }

    // Return the run id the moment the run is discoverable (so the client's /stream/<run> resolves). The child
    // instantiates .pi + writes run.json early; poll the SAME resolver /stream uses, then respond best-effort.
    let runDir: string | null = null;
    for (let i = 0; i < 20 && !runDir; i++) { const r = await resolveRunDir(runId); if (r) runDir = r.runDir; else await sleep(200); }

    return sendJson(res, 202, {
      run: runId,
      runDir,
      streamUrl: `/__piflow/stream/${encodeURIComponent(runId)}`,
      runViewUrl: `/__piflow/run-view/${encodeURIComponent(runId)}`,
      started: true,
      resolved: runDir != null,
    });
  };
}

/** The default POST /api/runs/start middleware — no allow-list (allow all), preserving today's behavior. */
export const piflowStartRun: Middleware = makePiflowStartRun();

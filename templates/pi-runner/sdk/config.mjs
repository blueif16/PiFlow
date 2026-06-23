// Thin config for the SDK entrypoint — the SUBSET of run.mjs's env+args the @piflow/core consumer
// needs (decision 6 of design/sdk-convergence-phase2.md: the consumer owns its own thin config; it
// does NOT import run.mjs, which stays the live engine). Mirrors run.mjs's loadDefaults (62-71),
// parseArgs (105-133), base resolution (97-102), and model resolution (135-136).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// HERE = the pi-runner/ dir (this file is pi-runner/sdk/config.mjs). The ajv schema loader scans it;
// the .env lives at pi-runner/.env; BASE_ROOT defaults to its parent (the repo root).
export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Load pi-runner/.env (KEY=VALUE). A real process.env value always wins (set only when undefined). */
export function loadDefaults(here = HERE) {
  let raw;
  try { raw = fs.readFileSync(path.join(here, ".env"), "utf8"); } catch { return; }
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

/**
 * Parse the CLI subset (PURE — no env, no fs except --arg-file). Mirrors run.mjs parseArgs for the
 * flags the SDK entrypoint supports: --run/--id, --arg k=v (repeatable), --arg-file k=path, --from,
 * --until, --only, --provider, --model, --node-timeout, --dry-run. `mode=companion` rides through as
 * a wfArg. Unknown flags throw (a typo must not silently no-op).
 */
export function parseArgs(argv) {
  const a = { run: undefined, wfArgs: {}, from: null, until: null, provider: null, model: null, nodeTimeout: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--run" || k === "--id") a.run = next();
    else if (k === "--arg") { const [key, ...rest] = next().split("="); a.wfArgs[key] = rest.join("="); }
    else if (k === "--arg-file") { const [key, ...rest] = next().split("="); a.wfArgs[key] = fs.readFileSync(path.resolve(rest.join("=")), "utf8"); }
    else if (k === "--from") a.from = next();
    else if (k === "--until") a.until = next();
    else if (k === "--only") { const v = next(); a.from = v; a.until = v; }
    else if (k === "--provider") a.provider = next();
    else if (k === "--model") a.model = next();
    else if (k === "--node-timeout") a.nodeTimeout = Number(next());
    else if (k === "--dry-run") a.dryRun = true;
    else throw new Error(`unknown arg: ${k}`);
  }
  if (!a.run) a.run = a.wfArgs.id || a.wfArgs.run || "run";
  return a;
}

/**
 * Resolve the full run config: .env + parsed args → the values runWorkflow + the bridge need. The
 * two-base model: BASE_ROOT = the repo root (where pi runs in-place + repo-relative reads resolve);
 * the project base (out/<run>) is derived in the entrypoint from wfArgs.projectDir.
 */
export function loadConfig(argv) {
  loadDefaults();
  const a = parseArgs(argv);
  const resolveFrom = (root, p, fb) => (!p ? fb : path.isAbsolute(p) ? p : path.join(root, p));
  const baseRoot = process.env.PI_RUNNER_ROOT ? path.resolve(process.env.PI_RUNNER_ROOT) : path.resolve(HERE, "..");
  const workflow = resolveFrom(baseRoot, process.env.PI_RUNNER_WORKFLOW, path.join(baseRoot, ".claude/workflows/CHANGEME.js"));
  // until='all' (run.mjs's no-truncation sentinel) ⇒ no window; null/empty from ⇒ no window.
  const until = a.until ?? process.env.PI_RUNNER_UNTIL ?? null;
  const from = a.from ?? process.env.PI_RUNNER_FROM ?? null;
  return {
    run: a.run,
    wfArgs: a.wfArgs,
    dryRun: a.dryRun,
    baseRoot,
    here: HERE,
    workflow,
    provider: a.provider || process.env.PI_RUNNER_PROVIDER || "cp",
    model: a.model || process.env.PI_RUNNER_MODEL || process.env.PI_CP_MODEL || "",
    nodeTimeoutMs: (a.nodeTimeout || Number(process.env.PI_RUNNER_NODE_TIMEOUT) || 1800) * 1000,
    // Silent-stall self-kill (seconds → ms; 0 = OFF, the default). Opt in via PI_RUNNER_STALL_TIMEOUT
    // for a hung node to die fast instead of running to the 30-min wall — but keep it well past the
    // cp provider's transient ~60-90s stream pauses (e.g. 300) so a thinking model is never false-killed.
    stallMs: (Number(process.env.PI_RUNNER_STALL_TIMEOUT) || 0) * 1000,
    from: from || undefined,
    until: until && until !== "all" ? until : undefined,
  };
}

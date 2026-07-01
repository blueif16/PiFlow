// GET /api/contexts + POST /api/migrate — the server support for the GUI's one-click run migration.
//
// The GUI can't run the CLI, and it can't POST a multi-MB bundle cross-origin to another serve's adopt
// endpoint (the serve sets no CORS). So the SERVE orchestrates the move, exactly as `start-run` spawns the
// runner: it reflects `~/.piflow/contexts.json` (names + baseUrls, NEVER tokens) for the target dropdown, and
// on POST it spawns `piflowctl context migrate <target> <run>` — the SAME tested freeze→bundle→adopt→use
// orchestration the CLI runs — returning the CHOSEN target's endpoint (incl. its token) so the GUI re-points
// its console to it. Because the serve drives it, the migration is laptop-side for an UPLOAD (local→cloud):
// the serve reaches both its own fleet and the cloud. (cloud→laptop download stays a CLI op — a cloud VM
// can't reach your laptop's localhost — the same limit the CLI has.)

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { findUp, readBody, resolveRunDir, sendJson, type Middleware } from "./resolve.js";

const LOCAL_CONTEXT = "local";
const LOCAL_BASE_URL = "http://127.0.0.1:5273";

interface ContextEntry {
  baseUrl: string;
  token?: string;
}
interface ContextsFile {
  current: string | null;
  contexts: Record<string, ContextEntry>;
}

/** `~/.piflow` (PIFLOW_HOME-aware) — mirrors @piflow/core `globalDir` / the CLI context-store, WITHOUT a static
 *  core import (the server keeps core out of its static graph so the SAME handlers run under Vite + serve). */
function piflowHome(): string {
  return process.env.PIFLOW_HOME ?? join(os.homedir(), ".piflow");
}

/** Read `~/.piflow/contexts.json`, tolerant + seeding the implicit `local` — the read side of the CLI store. */
export function readServerContexts(): ContextsFile {
  let file: ContextsFile = { current: null, contexts: {} };
  const p = join(piflowHome(), "contexts.json");
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<ContextsFile>;
      file = {
        current: typeof parsed.current === "string" ? parsed.current : null,
        contexts:
          parsed.contexts && typeof parsed.contexts === "object" ? (parsed.contexts as Record<string, ContextEntry>) : {},
      };
    } catch {
      file = { current: null, contexts: {} };
    }
  }
  if (!file.contexts[LOCAL_CONTEXT]) file.contexts[LOCAL_CONTEXT] = { baseUrl: LOCAL_BASE_URL };
  return file;
}

/** GET /api/contexts → the named endpoints (name + baseUrl only; NEVER a token) + the active pointer. */
export const piflowContexts: Middleware = async (req, res, next) => {
  if (!req.url?.match(/^\/api\/contexts(?:\?.*)?$/)) return next();
  if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
  const file = readServerContexts();
  const contexts = Object.entries(file.contexts).map(([name, e]) => ({ name, baseUrl: e.baseUrl }));
  return sendJson(res, 200, { current: file.current, contexts });
};

interface MigrateBody {
  run?: string;
  target?: string;
}

/**
 * POST /api/migrate `{ run, target }` → move `run` from THIS serve to the `target` context. Spawns
 * `piflowctl context migrate <target> <run>` (detached, like start-run) and returns 202 with the target's
 * endpoint (incl. token) so the GUI re-points. The run must exist on this serve; the target must be a known
 * context. Bearer-gated by createServer like every other route.
 */
export const piflowMigrateRun: Middleware = async (req, res, next) => {
  if (!req.url?.match(/^\/api\/migrate(?:\?.*)?$/)) return next();
  if (req.method !== "POST") return sendJson(res, 405, { error: "use POST to migrate a run" });

  let body: MigrateBody;
  try {
    body = JSON.parse(await readBody(req)) as MigrateBody;
  } catch {
    return sendJson(res, 400, { error: "body must be JSON" });
  }
  const run = typeof body.run === "string" ? body.run.trim() : "";
  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!run || !target) return sendJson(res, 400, { error: "run and target are required" });

  const file = readServerContexts();
  const entry = file.contexts[target];
  if (!entry) return sendJson(res, 404, { error: `unknown target context "${target}"` });

  // The run must exist on THIS serve (the migration source) before we try to move it.
  const resolved = await resolveRunDir(run);
  if (!resolved) return sendJson(res, 404, { error: `no run "${run}" on this serve` });

  const cliBin = findUp("packages/cli/dist/cli.js");
  const argv = ["context", "migrate", target, run];
  const cwd = resolved.workspaceRoot ?? process.cwd();
  try {
    const child = cliBin
      ? spawn(process.execPath, [cliBin, ...argv], { cwd, detached: true, stdio: "ignore" })
      : spawn("piflowctl", argv, { cwd, detached: true, stdio: "ignore" });
    child.on("error", (e) => process.stderr.write(`migrate: failed to spawn the migration (${String(e)})\n`));
    child.unref();
  } catch (e) {
    return sendJson(res, 500, { error: `failed to launch the migration (${String(e)})` });
  }

  // Hand back the CHOSEN target's endpoint (incl. token) so the GUI re-points its console to it after the move.
  return sendJson(res, 202, {
    run,
    target: { name: target, baseUrl: entry.baseUrl, token: entry.token ?? "" },
    migrating: true,
  });
};

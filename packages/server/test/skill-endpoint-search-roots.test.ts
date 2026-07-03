import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// The skill endpoint's bare-id search must use THE SAME ordered ring roots the runner stages from —
// core's `skillSearchRoots(workspace)` = [<workspace>/.agents/skills, <piflowHome>/skills] — so a skill
// the GUI can display is a skill the runtime actually stages (display ≡ staging). PIFLOW_HOME-hermetic
// temp dirs prove: (1) the INSTALLED ring ($PIFLOW_HOME/skills — NOT a hardcoded ~/.piflow) resolves;
// (2) the WORKSPACE ring shadows the installed ring (core's ordering); (3) the realpath confinement
// still 404s an out-of-root path even when the file exists.

let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowSkill } = await import("../src/handlers.js");

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowSkill,
  opts: { method: string; url: string },
): Promise<{ status: number; json?: unknown }> {
  return new Promise((resolve, reject) => {
    const req = { url: opts.url, method: opts.method, headers: {}, on: () => req, destroy() {} } as unknown as IncomingMessage;
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader() {},
      end(payload?: string) {
        if (ended) return;
        ended = true;
        resolve({ status: this.statusCode, json: payload ? JSON.parse(payload) : undefined });
      },
    } as unknown as ServerResponse;
    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
  });
}

const skillMd = (desc: string) => `---
name: ring-skill
description: "${desc}"
requires: [read]
allowed: [read]
---
# Ring Skill
`;

describe("skill endpoint — bare-id search uses core's ring roots (workspace ring then installed ring)", () => {
  let scratch: string;
  let workspace: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "piflow-skill-rings-"));
    workspace = join(scratch, "ws");
    home = join(scratch, "piflow-home");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    prevHome = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = home;
    runDirStub = { runDir: join(workspace, "runs", "r1"), workspaceRoot: workspace, historyDirs: [] };
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.PIFLOW_HOME;
    else process.env.PIFLOW_HOME = prevHome;
    rmSync(scratch, { recursive: true, force: true });
  });

  it("resolves a bare id from the INSTALLED ring ($PIFLOW_HOME/skills), not a hardcoded ~/.piflow", async () => {
    const dir = join(home, "skills", "ring1-only-skill-x7q");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd("Installed-ring copy."));

    const { status, json } = await call(piflowSkill, { method: "GET", url: "/__piflow/skill/r1?skill=ring1-only-skill-x7q" });
    expect(status).toBe(200);
    const r = json as { description: string; resolvedFrom: string };
    expect(r.description).toBe("Installed-ring copy.");
    expect(r.resolvedFrom).toBe(realpathSync(join(dir, "SKILL.md")));
  });

  it("the WORKSPACE ring (<ws>/.agents/skills) shadows the installed ring — core's staging order", async () => {
    const wsDir = join(workspace, ".agents", "skills", "both-rings-skill-x7q");
    const homeDir = join(home, "skills", "both-rings-skill-x7q");
    mkdirSync(wsDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(wsDir, "SKILL.md"), skillMd("WORKSPACE copy."));
    writeFileSync(join(homeDir, "SKILL.md"), skillMd("Installed copy."));

    const { status, json } = await call(piflowSkill, { method: "GET", url: "/__piflow/skill/r1?skill=both-rings-skill-x7q" });
    expect(status).toBe(200);
    const r = json as { description: string; resolvedFrom: string };
    expect(r.description).toBe("WORKSPACE copy.");
    expect(r.resolvedFrom).toBe(realpathSync(join(wsDir, "SKILL.md")));
  });

  it("confinement: an absolute path OUTSIDE every allowed root 404s even though the file exists", async () => {
    const outside = join(scratch, "outside", "leaky-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), skillMd("Should never be readable."));

    const { status, json } = await call(piflowSkill, {
      method: "GET",
      url: `/__piflow/skill/r1?skill=${encodeURIComponent(outside)}`,
    });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/not found in known skill dirs/);
  });
});

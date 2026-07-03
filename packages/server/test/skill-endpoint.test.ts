import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// `GET /__piflow/skill/<run>?skill=<id-or-path>` reads + parses a SKILL.md bundle for the GUI's skill panel.
// It reuses core's PURE `parseSkillManifest` for {id, requires, allowed, display} and pulls description + body
// from the `---` frontmatter itself. This drives the REAL handler against a temp SKILL.md fixture: it turns
// RED if the parse is dropped (empty requires/description), if needsMcp is mis-derived, or if the route or the
// bare-id root search regresses. resolveRunDir is stubbed so the fixture lives under a temp workspace root.

let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowSkill } = await import("../src/handlers.js");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "piflow-skill-"));
  runDirStub = null;
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

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

// requires ⊆ allowed (a core compile-time invariant) — the ceiling supersets the floor; `mcp.github:search`
// is both namespaced (`:`) and mcp-prefixed, so needsMcp MUST be true.
const FIXTURE = `---
name: sample-skill
description: "A sample skill for the endpoint test."
requires: [read, write, "mcp.github:search"]
allowed: [read, write, "mcp.github:search", edit]
---
# Sample Skill

Body markdown that the endpoint returns verbatim.
`;

describe("skill endpoint — read + parse a SKILL.md bundle", () => {
  it("200s with the parsed manifest for a bare-id skill under the workspace root", async () => {
    const skillDir = join(scratch, "sample-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), FIXTURE);
    runDirStub = { runDir: join(scratch, "runs", "r1"), workspaceRoot: scratch, historyDirs: [] };

    const { status, json } = await call(piflowSkill, { method: "GET", url: "/__piflow/skill/r1?skill=sample-skill" });
    expect(status).toBe(200);

    const r = json as {
      id: string; name: string; description: string;
      requires: string[]; allowed: string[]; needsMcp: boolean;
      body: string; resolvedFrom: string;
    };
    expect(r.id).toBe("sample-skill");
    expect(r.name).toBe("sample-skill"); // no display.label ⇒ falls back to id
    expect(r.description).toBe("A sample skill for the endpoint test.");
    expect(r.requires).toEqual(["read", "write", "mcp.github:search"]);
    expect(r.allowed).toEqual(["read", "write", "mcp.github:search", "edit"]);
    expect(r.needsMcp).toBe(true);
    expect(r.body).toContain("# Sample Skill");
    expect(r.body).toContain("Body markdown that the endpoint returns verbatim.");
    expect(r.resolvedFrom.endsWith(join("sample-skill", "SKILL.md"))).toBe(true);
  });

  it("404s for an unknown bare id (not in the workspace or any home skill dir)", async () => {
    runDirStub = { runDir: join(scratch, "runs", "r1"), workspaceRoot: scratch, historyDirs: [] };
    const { status, json } = await call(piflowSkill, {
      method: "GET",
      url: "/__piflow/skill/r1?skill=definitely-not-a-real-skill-9f3a2c",
    });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/not found in known skill dirs/);
  });

  it("400s when ?skill is absent", async () => {
    runDirStub = { runDir: join(scratch, "runs", "r1"), workspaceRoot: scratch, historyDirs: [] };
    const { status, json } = await call(piflowSkill, { method: "GET", url: "/__piflow/skill/r1" });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/skill/);
  });

  it("falls through (next) when the URL is not a skill route", async () => {
    await expect(call(piflowSkill, { method: "GET", url: "/__piflow/tree/x" })).rejects.toThrow("route did not match");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// `GET /__piflow/skills/<run>` is the MARKETPLACE listing the GUI panel renders: every skill in BOTH local
// rings (the run's workspace `.agents/skills` + the installed `<piflowHome>/skills`) via core's `listSkills`,
// each entry WIDENED with `mcpRequires` (the `mcp.*` ids its manifest `requires`) and `provisioned` (whether
// every one of those ids is present in the cached `~/.piflow/catalog/mcp.index.json` slice). This drives the
// REAL handler against real fixture dirs (PIFLOW_HOME-hermetic) — RED if listing drops a ring, if the shadow
// flag is lost crossing the JSON wire, if mcp provisioning is mis-derived, or if an absent workspace root
// 500s instead of degrading to the installed ring alone. `resolveRunDir` is stubbed (the SAME seam every
// sibling run-scoped handler test stubs) so the fixture never touches the real global index.

let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowSkillsMarketplace } = await import("../src/handlers.js");

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowSkillsMarketplace,
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

type Entry = {
  id: string; dir: string; ring: "workspace" | "installed"; name: string; description: string;
  requires: string[]; allowed: string[]; shadowed?: boolean; error?: string;
  mcpRequires: string[]; provisioned: boolean;
};

/** Write a minimal, VALID SKILL.md (requires ⊆ allowed — core's manifest invariant, else parseSkillManifest throws). */
function writeSkill(dir: string, opts: { desc?: string; requires?: string[]; allowed?: string[] } = {}): void {
  mkdirSync(dir, { recursive: true });
  const requires = opts.requires ?? [];
  const allowed = opts.allowed ?? requires;
  const list = (xs: string[]) => `[${xs.map((x) => `"${x}"`).join(", ")}]`;
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\ndescription: "${opts.desc ?? "a fixture skill"}"\nrequires: ${list(requires)}\nallowed: ${list(allowed)}\n---\n# Fixture\n`,
  );
}

/** Write the cached MCP catalog slice the handler reads (`<home>/catalog/mcp.index.json`). */
function writeCatalog(home: string, addresses: string[]): void {
  const dir = join(home, "catalog");
  mkdirSync(dir, { recursive: true });
  const entries = addresses.map((address) => ({ address, source: "mcp", piName: address.replace(/[.:]/g, "_"), description: address }));
  writeFileSync(join(dir, "mcp.index.json"), JSON.stringify({ entries }));
}

describe("GET /__piflow/skills/<run> — the skill marketplace listing", () => {
  let scratch: string;
  let workspace: string;
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "piflow-skills-marketplace-"));
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

  it("returns skills from BOTH rings for a fixture run", async () => {
    writeSkill(join(workspace, ".agents", "skills", "workspace-skill"), { desc: "lives in the workspace ring" });
    writeSkill(join(home, "skills", "installed-skill"), { desc: "lives in the installed ring" });

    const { status, json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/r1" });
    expect(status).toBe(200);
    const body = json as { skills: Entry[]; mcpCatalog: boolean };
    const byId = Object.fromEntries(body.skills.map((s) => [s.id, s]));
    expect(byId["workspace-skill"]?.ring).toBe("workspace");
    expect(byId["installed-skill"]?.ring).toBe("installed");
    expect(body.skills).toHaveLength(2);
  });

  it("the shadow flag survives the JSON wire for an id present in both rings", async () => {
    writeSkill(join(workspace, ".agents", "skills", "dup-skill"), { desc: "workspace copy" });
    writeSkill(join(home, "skills", "dup-skill"), { desc: "installed copy" });

    const { json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/r1" });
    const body = json as { skills: Entry[] };
    const dups = body.skills.filter((s) => s.id === "dup-skill");
    expect(dups).toHaveLength(2);
    const ws = dups.find((s) => s.ring === "workspace")!;
    const inst = dups.find((s) => s.ring === "installed")!;
    expect(ws.shadowed).toBeFalsy(); // workspace wins the clash — never shadowed
    expect(inst.shadowed).toBe(true); // installed copy is hidden behind the workspace one
  });

  it("derives mcpRequires from requires and marks provisioned against the catalog fixture", async () => {
    writeSkill(join(home, "skills", "partially-provisioned"), {
      desc: "needs two mcp tools, only one is cataloged",
      requires: ["mcp.github:search", "mcp.missing:tool"],
    });
    writeSkill(join(home, "skills", "fully-provisioned"), {
      desc: "needs one mcp tool that IS cataloged",
      requires: ["mcp.github:search"],
    });
    writeSkill(join(home, "skills", "no-mcp-needs"), { desc: "no mcp requirement at all", requires: ["read"] });
    writeCatalog(home, ["mcp.github:search"]);

    const { json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/r1" });
    const body = json as { skills: Entry[]; mcpCatalog: boolean };
    const byId = Object.fromEntries(body.skills.map((s) => [s.id, s]));

    expect(byId["partially-provisioned"]?.mcpRequires).toEqual(["mcp.github:search", "mcp.missing:tool"]);
    expect(byId["partially-provisioned"]?.provisioned).toBe(false);

    expect(byId["fully-provisioned"]?.mcpRequires).toEqual(["mcp.github:search"]);
    expect(byId["fully-provisioned"]?.provisioned).toBe(true);

    expect(byId["no-mcp-needs"]?.mcpRequires).toEqual([]);
    expect(byId["no-mcp-needs"]?.provisioned).toBe(true); // empty mcpRequires ⇒ vacuously provisioned

    expect(body.mcpCatalog).toBe(true);
  });

  it("no workspace root ⇒ the installed ring alone, 200 (never a 500)", async () => {
    runDirStub = { runDir: join(scratch, "orphan-run"), workspaceRoot: null, historyDirs: [] };
    writeSkill(join(home, "skills", "installed-only"), { desc: "installed ring skill" });

    const { status, json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/r1" });
    expect(status).toBe(200);
    const body = json as { skills: Entry[] };
    expect(body.skills.every((s) => s.ring === "installed")).toBe(true);
    expect(body.skills.some((s) => s.id === "installed-only")).toBe(true);
  });

  it("404s for an unknown run", async () => {
    runDirStub = null;
    const { status, json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/does-not-exist" });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/no run/);
  });

  it("falls through (next) when the URL is not a skills-marketplace route", async () => {
    await expect(call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skill/r1?skill=x" })).rejects.toThrow(
      "route did not match",
    );
  });

  it("SCALE: 50 fixture skills in the installed ring all return, correctly shaped", async () => {
    for (let i = 0; i < 50; i++) {
      const id = `bulk-skill-${String(i).padStart(3, "0")}`;
      writeSkill(join(home, "skills", id), { desc: `bulk fixture #${i}`, requires: i % 2 === 0 ? ["mcp.bulk:tool"] : [] });
    }
    writeCatalog(home, ["mcp.bulk:tool"]);

    const { status, json } = await call(piflowSkillsMarketplace, { method: "GET", url: "/__piflow/skills/r1" });
    expect(status).toBe(200);
    const body = json as { skills: Entry[]; mcpCatalog: boolean };
    expect(body.skills).toHaveLength(50);
    for (const s of body.skills) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(typeof s.description).toBe("string");
      expect(Array.isArray(s.requires)).toBe(true);
      expect(Array.isArray(s.allowed)).toBe(true);
      expect(Array.isArray(s.mcpRequires)).toBe(true);
      expect(typeof s.provisioned).toBe("boolean");
      expect(s.ring).toBe("installed");
    }
    // every id is unique — no dedup/collision bug at scale
    expect(new Set(body.skills.map((s) => s.id)).size).toBe(50);
    expect(body.mcpCatalog).toBe(true);
  });
});

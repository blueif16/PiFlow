import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// `GET /__piflow/skill-search?q=<text>[&sources=a,b][&limit=n]` — the GUI marketplace's ONLINE lane: a thin
// adapter over core's `searchRemote` (the row mapping/source behaviors are core's suite; THIS suite pins the
// adapter contract): q is required (400), limit must be a positive integer (400), sources csv is forwarded,
// rows come back as `{ rows }`, and an upstream searchRemote failure is a clean 502 message (never a stack).
// `findCore` is stubbed (the sibling handlers' resolve.js-seam pattern) to point at a FIXTURE module whose
// fake `searchRemote` records its inputs — zero network here.

let fakeCorePath: string | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, findCore: vi.fn((sub: string) => (sub === "workflow/ops/skill-remote.js" ? fakeCorePath : actual.findCore(sub))) };
});

const { piflowSkillSearch } = await import("../src/handlers.js");

function call(opts: { method: string; url: string }): Promise<{ status: number; json?: any }> {
  return new Promise((resolve, reject) => {
    const req = { url: opts.url, method: opts.method, headers: {}, on: () => req, destroy() {} } as unknown as IncomingMessage;
    const chunks: string[] = [];
    const res = {
      statusCode: 200,
      setHeader() {},
      writeHead(code: number) {
        (res as any).statusCode = code;
      },
      end(body?: string) {
        if (body) chunks.push(body);
        try {
          resolve({ status: (res as any).statusCode, json: chunks.length ? JSON.parse(chunks.join("")) : undefined });
        } catch {
          resolve({ status: (res as any).statusCode });
        }
      },
    } as unknown as ServerResponse;
    void piflowSkillSearch(req, res, () => reject(new Error("fell through to next()")));
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "piflow-skill-search-"));
});
afterEach(() => {
  fakeCorePath = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fixture core module whose searchRemote records (q, opts) and returns `rows` (or throws). */
function seedFakeCore(body: string): void {
  fakeCorePath = join(dir, "skill-remote.mjs");
  writeFileSync(fakeCorePath, body, "utf8");
}

describe("GET /__piflow/skill-search — the online marketplace lane", () => {
  it("forwards q/sources/limit to core searchRemote and returns { rows }", async () => {
    seedFakeCore(`
      export async function searchRemote(q, opts) {
        return [{ slug: 's', name: 'n', description: 'd', source: 'https://github.com/a/b', index: 'agentskill', __echo: { q, sources: opts.sources, limit: opts.limit } }];
      }
    `);
    const r = await call({ method: "GET", url: "/__piflow/skill-search?q=review&sources=agentskill,skillsmp&limit=7" });
    expect(r.status).toBe(200);
    expect(r.json.rows).toHaveLength(1);
    expect(r.json.rows[0].__echo).toEqual({ q: "review", sources: ["agentskill", "skillsmp"], limit: 7 });
  });

  it("defaults: no sources/limit params ⇒ neither is passed (core's own defaults rule)", async () => {
    seedFakeCore(`
      export async function searchRemote(q, opts) {
        return [{ slug: 's', name: 'n', description: '', source: 'x', index: 'topagentskills', __opts: opts }];
      }
    `);
    const r = await call({ method: "GET", url: "/__piflow/skill-search?q=pdf" });
    expect(r.status).toBe(200);
    expect(r.json.rows[0].__opts.sources).toBeUndefined();
    expect(r.json.rows[0].__opts.limit).toBeUndefined();
  });

  it("a missing q is a 400, never an upstream call", async () => {
    seedFakeCore(`export async function searchRemote() { throw new Error('must not be called'); }`);
    const r = await call({ method: "GET", url: "/__piflow/skill-search" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/q/);
  });

  it("a non-positive-integer limit is a 400", async () => {
    seedFakeCore(`export async function searchRemote() { throw new Error('must not be called'); }`);
    const r = await call({ method: "GET", url: "/__piflow/skill-search?q=x&limit=zero" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/limit/);
  });

  it("an upstream searchRemote failure surfaces as 502 with the message (a clean line, not a stack)", async () => {
    seedFakeCore(`export async function searchRemote() { throw new Error('agentskill: search request failed (HTTP 503)'); }`);
    const r = await call({ method: "GET", url: "/__piflow/skill-search?q=x" });
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toContain("agentskill: search request failed");
  });
});

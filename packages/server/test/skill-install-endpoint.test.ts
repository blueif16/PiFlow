import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// `POST /__piflow/skill-install` — the GUI's one-click Install: a thin adapter over core's `installSkill`
// (git clone + copy to <piflowHome>/skills; the install BEHAVIOR is core's suite, THIS suite pins the adapter
// contract): POST-only (405), JSON body { source } required (400), success forwards core's InstalledSkill
// record, and a core failure (clone/parse/validation) is a clean 502 message — NEVER a 500/stack. `findCore`
// is stubbed (the sibling handlers' resolve.js-seam pattern) to a FIXTURE whose fake `installSkill` records
// its inputs and returns/throws — zero clone, zero fs.

let fakeCorePath: string | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return {
    ...actual,
    findCore: vi.fn((sub: string) => (sub === "workflow/ops/skill-install.js" ? fakeCorePath : actual.findCore(sub))),
  };
});

const { piflowSkillInstall } = await import("../src/handlers.js");

/** Drive the handler with a fake req/res; a body is streamed via req.on('data')/('end') (readBody's shape). */
function call(opts: { method: string; url: string; body?: string }): Promise<{ status: number; json?: any }> {
  return new Promise((resolve, reject) => {
    const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
    const req = {
      url: opts.url,
      method: opts.method,
      headers: {},
      on(ev: string, cb: (arg?: unknown) => void) {
        (listeners[ev] ||= []).push(cb);
        // readBody wires 'data' then 'end'; fire synchronously once 'end' is subscribed.
        if (ev === "end") {
          if (opts.body !== undefined) for (const d of listeners["data"] ?? []) d(opts.body);
          cb();
        }
        return req;
      },
      destroy() {},
    } as unknown as IncomingMessage;
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
    void piflowSkillInstall(req, res, () => reject(new Error("fell through to next()")));
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "piflow-skill-install-"));
});
afterEach(() => {
  fakeCorePath = null;
  rmSync(dir, { recursive: true, force: true });
});

/** Write a fixture core module whose installSkill records (source, opts) and returns a record (or throws). */
function seedFakeCore(body: string): void {
  fakeCorePath = join(dir, "skill-install.mjs");
  writeFileSync(fakeCorePath, body, "utf8");
}

describe("POST /__piflow/skill-install — the one-click install adapter", () => {
  it("forwards source + pick/force to core installSkill and returns the InstalledSkill record", async () => {
    seedFakeCore(`
      export class SkillInstallError extends Error {}
      export async function installSkill(source, opts) {
        return { id: 'pdf', dest: '/home/.piflow/skills/pdf', sha256: 'abc123', source, installedAt: 't',
                 __echo: { pick: opts.pick, force: opts.force } };
      }
    `);
    const r = await call({
      method: "POST",
      url: "/__piflow/skill-install",
      body: JSON.stringify({ source: "anthropics/skills", skill: "pdf", force: true }),
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe("pdf");
    expect(r.json.dest).toBe("/home/.piflow/skills/pdf");
    expect(r.json.sha256).toBe("abc123");
    expect(r.json.source).toBe("anthropics/skills"); // provenance = the source as posted
    expect(r.json.__echo).toEqual({ pick: "pdf", force: true }); // pick/force actually reach core
  });

  it("a non-POST method is a 405, never touching core", async () => {
    seedFakeCore(`export async function installSkill() { throw new Error('must not be called'); }`);
    const r = await call({ method: "GET", url: "/__piflow/skill-install" });
    expect(r.status).toBe(405);
  });

  it("a non-JSON body is a 400", async () => {
    seedFakeCore(`export async function installSkill() { throw new Error('must not be called'); }`);
    const r = await call({ method: "POST", url: "/__piflow/skill-install", body: "not json{" });
    expect(r.status).toBe(400);
  });

  it("a missing/blank source is a 400, never an install attempt", async () => {
    seedFakeCore(`export async function installSkill() { throw new Error('must not be called'); }`);
    const r = await call({ method: "POST", url: "/__piflow/skill-install", body: JSON.stringify({ source: "  " }) });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/source/);
  });

  it("a core install failure surfaces as a clean 502 message — NEVER a 500/stack", async () => {
    // The load-bearing assertion: an unauthenticated caller must never see an internal stack, and an install
    // failure (bad source, clone fail, invalid manifest) is an expected 502, not a server error.
    seedFakeCore(`
      export class SkillInstallError extends Error {}
      export async function installSkill() { throw new SkillInstallError("git clone of https://x failed: not found"); }
    `);
    const r = await call({
      method: "POST",
      url: "/__piflow/skill-install",
      body: JSON.stringify({ source: "https://x" }),
    });
    expect(r.status).toBe(502);
    expect(String(r.json.error)).toContain("git clone of https://x failed");
    expect(String(r.json.error)).not.toMatch(/\n\s+at /); // no stack frames leaked
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// GET /api/contexts reflects ~/.piflow/contexts.json (names + baseUrls, NEVER tokens); POST /api/migrate
// validates run+target then spawns `piflowctl context migrate` and returns the target endpoint to re-point to.

const { spawnSpy } = vi.hoisted(() => ({ spawnSpy: vi.fn(() => ({ on: () => {}, unref: () => {} })) }));
vi.mock("node:child_process", () => ({ spawn: spawnSpy }));

// resolveRunDir gates the migrate success path (the run must exist on this serve) — settable per test.
let runDirStub: { runDir: string; workspaceRoot: string | null } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowContexts, piflowMigrateRun, readServerContexts } = await import("../src/contexts.js");

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "piflow-ctx-"));
  process.env.PIFLOW_HOME = home;
  spawnSpy.mockClear();
  runDirStub = null;
});
afterEach(() => {
  delete process.env.PIFLOW_HOME;
  rmSync(home, { recursive: true, force: true });
});

const writeContexts = (obj: unknown) => writeFileSync(join(home, "contexts.json"), JSON.stringify(obj));

/** Drive a middleware with a fake req/res; returns { status, json }. */
function call(
  handler: import("../src/resolve.js").Middleware,
  opts: { method: string; url: string; body?: string },
): Promise<{ status: number; json?: unknown }> {
  return new Promise((resolve, reject) => {
    let onData: ((c: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    const req = {
      url: opts.url,
      method: opts.method,
      headers: {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "data") onData = cb as (c: Buffer) => void;
        if (event === "end") onEnd = cb as () => void;
        return req;
      },
      destroy() {},
    } as unknown as IncomingMessage;
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
    queueMicrotask(() => {
      if (opts.body != null) onData?.(Buffer.from(opts.body));
      onEnd?.();
    });
  });
}

describe("readServerContexts", () => {
  it("seeds the implicit `local` context when the file is absent", () => {
    const f = readServerContexts();
    expect(f.contexts.local).toEqual({ baseUrl: "http://127.0.0.1:5273" });
  });

  it("parses a written file and keeps the current pointer", () => {
    writeContexts({ current: "cloud", contexts: { cloud: { baseUrl: "https://x.fly.dev", token: "t" } } });
    const f = readServerContexts();
    expect(f.current).toBe("cloud");
    expect(f.contexts.cloud.baseUrl).toBe("https://x.fly.dev");
    expect(f.contexts.local).toBeTruthy(); // still seeded alongside
  });

  it("tolerates a corrupt file (degrades to seeded local)", () => {
    writeFileSync(join(home, "contexts.json"), "{not json");
    expect(readServerContexts().contexts.local).toBeTruthy();
  });
});

describe("GET /api/contexts", () => {
  it("returns names + baseUrls and the active pointer — but NEVER a token", async () => {
    writeContexts({ current: "cloud", contexts: { cloud: { baseUrl: "https://x.fly.dev", token: "SECRET-TOKEN" } } });
    const { status, json } = await call(piflowContexts, { method: "GET", url: "/api/contexts" });
    expect(status).toBe(200);
    const body = json as { current: string; contexts: { name: string; baseUrl: string }[] };
    expect(body.current).toBe("cloud");
    const cloud = body.contexts.find((c) => c.name === "cloud")!;
    expect(cloud.baseUrl).toBe("https://x.fly.dev");
    // the security property: no token field is ever serialized to the client
    expect(JSON.stringify(body)).not.toContain("SECRET-TOKEN");
    expect(cloud).not.toHaveProperty("token");
  });

  it("405s a non-GET", async () => {
    const { status } = await call(piflowContexts, { method: "POST", url: "/api/contexts" });
    expect(status).toBe(405);
  });
});

describe("POST /api/migrate", () => {
  it("400s when run or target is missing", async () => {
    const { status } = await call(piflowMigrateRun, { method: "POST", url: "/api/migrate", body: JSON.stringify({ run: "r1" }) });
    expect(status).toBe(400);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("404s an unknown target context (never spawns)", async () => {
    writeContexts({ current: null, contexts: {} });
    const { status } = await call(piflowMigrateRun, { method: "POST", url: "/api/migrate", body: JSON.stringify({ run: "r1", target: "nope" }) });
    expect(status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("404s when the run is not on this serve (never spawns)", async () => {
    writeContexts({ current: null, contexts: { cloud: { baseUrl: "https://x.fly.dev", token: "t" } } });
    runDirStub = null; // resolveRunDir → no such run
    const { status } = await call(piflowMigrateRun, { method: "POST", url: "/api/migrate", body: JSON.stringify({ run: "r1", target: "cloud" }) });
    expect(status).toBe(404);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("spawns `piflowctl context migrate <target> <run>` and returns the target endpoint (incl. token) to re-point", async () => {
    writeContexts({ current: null, contexts: { cloud: { baseUrl: "https://x.fly.dev", token: "CLOUD-TOKEN" } } });
    runDirStub = { runDir: "/p/.piflow/greet/runs/r1", workspaceRoot: "/p" };
    const { status, json } = await call(piflowMigrateRun, { method: "POST", url: "/api/migrate", body: JSON.stringify({ run: "r1", target: "cloud" }) });
    expect(status).toBe(202);
    const body = json as { run: string; target: { name: string; baseUrl: string; token: string }; migrating: boolean };
    expect(body.target).toEqual({ name: "cloud", baseUrl: "https://x.fly.dev", token: "CLOUD-TOKEN" });
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    // the spawned argv includes the CLI migrate verb with the target + run (order-sensitive)
    const argv = (spawnSpy.mock.calls[0] as unknown[]).flat().map(String).join(" ");
    expect(argv).toContain("context migrate cloud r1");
  });
});

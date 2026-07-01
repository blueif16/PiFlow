import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// The 403 gate on POST /api/runs/start must fire AFTER resolveTemplateDir succeeds and BEFORE the runner is
// spawned: a rejected template returns 403 and NEVER launches an agent (spawn is the credentialed RCE seam).
// So we spy the spawn and assert (rejected) 403 + zero spawns, (allowed) the gate passes through to spawn.

// spy node:child_process.spawn — the credentialed launch seam. On the allowed path it returns a stub child.
const spawnSpy = vi.fn(() => ({
  on: () => {},
  unref: () => {},
}));
vi.mock("node:child_process", () => ({ spawn: spawnSpy }));

// keep the real resolve.js EXCEPT resolveRunDir, which the allowed path polls 20×200ms — stub it to return
// immediately so the allowed-path test doesn't wait ~4s. sendJson/readBody/etc. stay real.
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => null) };
});

// import AFTER the mocks so start-run.ts binds the mocked spawn/resolveRunDir.
const { makePiflowStartRun } = await import("../src/start-run.js");

// A minimal fixture template dir (resolveTemplateDir only needs meta.json to exist for the templateDir form).
let fixtureDir: string;
beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "piflow-tpl-"));
  writeFileSync(join(fixtureDir, "meta.json"), JSON.stringify({ name: "wf" }));
  spawnSpy.mockClear();
});
afterEach(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

// Drive a middleware with a fake POST req/res; resolve when the response is sent.
function callStart(handler: ReturnType<typeof makePiflowStartRun>, body: object) {
  return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
    const chunks = [Buffer.from(JSON.stringify(body))];
    let onData: ((c: Buffer) => void) | undefined;
    let onEnd: (() => void) | undefined;
    const req = {
      url: "/api/runs/start",
      method: "POST",
      headers: {},
      on(event: string, cb: (...a: unknown[]) => void) {
        if (event === "data") onData = cb as (c: Buffer) => void;
        if (event === "end") onEnd = cb as () => void;
        return req;
      },
    } as unknown as IncomingMessage;

    let payload = "";
    const res = {
      statusCode: 200,
      setHeader() {},
      end(s?: string) {
        if (s) payload = s;
        resolve({ status: this.statusCode, json: payload ? JSON.parse(payload) : undefined });
      },
    } as unknown as ServerResponse;

    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
    // feed the body after the handler has attached its data/end listeners.
    queueMicrotask(() => { for (const c of chunks) onData?.(c); onEnd?.(); });
  });
}

describe("piflowStartRun — template allow-listing gate", () => {
  it("no allowlist ⇒ the gate is a no-op: an existing template reaches spawn (today's behavior)", async () => {
    const handler = makePiflowStartRun(undefined);
    const { status } = await callStart(handler, { templateDir: fixtureDir });
    expect(status).toBe(202);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it("allowlist REJECTS the template ⇒ 403 {error:'template not allowed'} and NO spawn", async () => {
    const handler = makePiflowStartRun(["/some/other/allowed/template"]);
    const { status, json } = await callStart(handler, { templateDir: fixtureDir });
    expect(status).toBe(403);
    expect(json).toEqual({ error: "template not allowed" });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("allowlist ALLOWS the template ⇒ the gate passes through to spawn (202)", async () => {
    const handler = makePiflowStartRun([fixtureDir]);
    const { status } = await callStart(handler, { templateDir: fixtureDir });
    expect(status).toBe(202);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });
});

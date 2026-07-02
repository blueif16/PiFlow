import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Target 2 TEST CONTRACT (b) — the REACH test (GUARDRAIL, full-run-e2e-LOCKED.md §"Target 2").
//
// The N-127 mint test proves the control plane PROJECTS E2B_TEMPLATE/E2B_API_KEY; it does NOT prove the var
// REACHES the spawned worker child's process.env. The load-bearing link is that POST /api/runs/start spawns
// the detached `piflowctl run` child with NO `env` override in the spawn options (start-run.ts:132-134 —
// { cwd, detached:true, stdio:"ignore" }), so Node defaults the child's env to process.env and it INHERITS
// E2B_TEMPLATE/E2B_API_KEY. This GUARDRAIL characterizes that inheritance contract: it must PASS today.
// Teeth (verify phase): a refactor adding `env: {...scrubbed}` to the spawn options (dropping the inherited
// E2B_TEMPLATE) reds `expect(opts).not.toHaveProperty('env')` — the exact regression that silently re-breaks
// N-127 reach. This mutates the real start-run.ts spawn call, not a test option.

// Spy node:child_process.spawn (the credentialed launch seam). Return a stub child with unref/on so the
// middleware's `child.on('error',…)` + `child.unref()` don't throw. We inspect the 3rd arg (spawn options).
const spawnSpy = vi.fn(() => ({
  on: () => {},
  unref: () => {},
}));
vi.mock("node:child_process", () => ({ spawn: spawnSpy }));

// Keep the real resolve.js EXCEPT resolveRunDir, which the spawned path polls 20×200ms — stub it to return
// immediately so the test doesn't wait ~4s. sendJson/readBody/etc. stay real (reuse of the allowlist harness).
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

// Drive the middleware with a fake POST req/res; resolve when the response is sent (reuse of the allowlist
// harness `callStart`). Feeds the JSON body after the handler attaches its data/end listeners.
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
    queueMicrotask(() => { for (const c of chunks) onData?.(c); onEnd?.(); });
  });
}

describe("makePiflowStartRun — the worker child INHERITS process.env (N-127 reach guardrail)", () => {
  it("spawns the detached run with NO `env` override, so E2B_TEMPLATE/E2B_API_KEY reach the child from process.env", async () => {
    const handler = makePiflowStartRun(undefined);
    const { status } = await callStart(handler, { templateDir: fixtureDir, sandbox: "e2b" });
    expect(status).toBe(202);
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    // The spawn options object is the 3rd arg (both spawn forms in start-run.ts pass options at index 2).
    const opts = spawnSpy.mock.calls[0][2] as Record<string, unknown>;
    // The load-bearing inheritance link: no `env` key ⇒ Node defaults the child env to process.env.
    expect(opts).not.toHaveProperty("env");
  });

  it("spawns detached + stdio:'ignore' (the crash-durable, output-detached launch contract)", async () => {
    const handler = makePiflowStartRun(undefined);
    const { status } = await callStart(handler, { templateDir: fixtureDir, sandbox: "e2b" });
    expect(status).toBe(202);

    const opts = spawnSpy.mock.calls[0][2] as Record<string, unknown>;
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
  });
});

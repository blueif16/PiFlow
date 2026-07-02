import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { piflowAgents } from "../src/handlers.js";

// `GET /__piflow/agents.json` is WIDENED (P4, §2.5) to ALSO carry the built-in DRIVER catalog — the
// discovery-card surface joined OUTSIDE core (the server calls the pure static `describe()`; core still
// enumerates nothing). This test proves the WIRING: the response body carries a `drivers` array whose
// descriptors include the two built-ins (`pi`, `claude-code`). The stub does NOT append `drivers`, so this
// bites RED for the missing-behavior reason. It also asserts the preset rows survive (additive widen).
//
// It drives the REAL handler against the REAL built @piflow/core dist (no mock) — findCore resolves
// packages/core/dist via findUp — so a stub that forgets the drivers join fails, and a real join passes.

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowAgents,
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

describe("agents.json — driver catalog widen (P4)", () => {
  it("the response carries a `drivers` array containing the pi and claude-code descriptors (ids present)", async () => {
    const { status, json } = await call(piflowAgents, { method: "GET", url: "/__piflow/agents.json" });
    expect(status).toBe(200);

    // The widened surface: a `drivers` array of AgentDriverDescriptor cards.
    const body = json as { drivers?: Array<{ id?: string }> };
    expect(Array.isArray(body.drivers)).toBe(true);
    const ids = (body.drivers ?? []).map((d) => d.id);
    expect(ids).toContain("pi");
    expect(ids).toContain("claude-code");
  });

  it("falls through (next) when the URL is not the agents route", async () => {
    await expect(
      call(piflowAgents, { method: "GET", url: "/__piflow/run-view/x" }),
    ).rejects.toThrow("route did not match");
  });
});

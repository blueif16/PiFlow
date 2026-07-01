import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runJsonFile, buildRunView, projectRunDigest, type RunStatus } from "@piflow/core";

// `GET /__piflow/run-digest/<run>` is the run-view route's twin: it resolves the run dir the SAME way, but
// returns the agent-facing PROJECTION (projectRunDigest) instead of the raw view. The projection itself is
// exhaustively covered by core's telemetry.test — here we prove only the WIRING: the route matches, an
// unresolved run 404s, and the body is byte-for-byte `projectRunDigest(buildRunView(runDir))` (so returning
// the raw view, dropping the projection, or mis-passing historyDirs all turn this RED).

// resolveRunDir is the run-dir lookup the handler shares with run-view/stream; make it settable per test.
let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowRunDigest } = await import("../src/handlers.js");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "piflow-digest-"));
  runDirStub = null;
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Build a minimal real `.pi/` run dir (via the layout helper's path — never a hardcoded `.pi/`). */
function writeRun(runDir: string, status: RunStatus): void {
  const rj = runJsonFile(runDir);
  mkdirSync(dirname(rj), { recursive: true });
  writeFileSync(rj, JSON.stringify(status));
}

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowRunDigest,
  opts: { method: string; url: string },
): Promise<{ status: number; json?: unknown }> {
  return new Promise((resolve, reject) => {
    const req = { url: opts.url, method: opts.method, headers: {}, on: () => req, destroy() {} } as unknown as IncomingMessage;
    const headers: Record<string, string> = {};
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
      end(payload?: string) {
        if (ended) return;
        ended = true;
        resolve({ status: this.statusCode, json: payload ? JSON.parse(payload) : undefined });
      },
    } as unknown as ServerResponse;
    Promise.resolve(handler(req, res, () => reject(new Error("route did not match")))).catch(reject);
  });
}

function okRun(): RunStatus {
  return {
    run: "flaky-pecan",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    done: true,
    ok: true,
    durationMs: 1000,
    stage: null,
    totals: null,
    nodes: {
      n1: { id: "n1", label: "First", status: "ok", artifacts: [], issues: [] },
      n2: { id: "n2", label: "Second", status: "ok", artifacts: [], issues: [] },
    },
  };
}

describe("run-digest endpoint", () => {
  it("returns projectRunDigest(buildRunView(runDir)) for a resolved run", async () => {
    const runDir = join(scratch, "run");
    writeRun(runDir, okRun());
    runDirStub = { runDir, workspaceRoot: null, historyDirs: [] };

    const { status, json } = await call(piflowRunDigest, { method: "GET", url: "/__piflow/run-digest/flaky-pecan" });

    // Independently project the same fixture — the handler must return exactly this.
    const { view } = buildRunView(runDir, { historyDirs: [], workspaceRoot: null });
    const expected = projectRunDigest(view);

    expect(status).toBe(200);
    expect(json).toEqual(JSON.parse(JSON.stringify(expected)));
    // Digest-only keys the raw run-view does NOT carry — proves the projection was applied.
    const d = json as { anomalies: unknown[]; rootCauses: unknown[]; totals: { nodes: number } };
    expect(Array.isArray(d.anomalies)).toBe(true);
    expect(Array.isArray(d.rootCauses)).toBe(true);
    expect(d.totals.nodes).toBe(2);
  });

  it("404s when the run does not resolve", async () => {
    runDirStub = null;
    const { status, json } = await call(piflowRunDigest, { method: "GET", url: "/__piflow/run-digest/nope" });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/no run "nope"/);
  });

  it("falls through (next) when the URL is not a run-digest route", async () => {
    await expect(call(piflowRunDigest, { method: "GET", url: "/__piflow/run-view/x" })).rejects.toThrow("route did not match");
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
// `listIssues`/`writeIssueFile`/`computeIssueId` are core-INTERNAL (optimize/substrate/issues.ts) — not part
// of @piflow/core's public root export map, so the fixture writer + the "what should the route return"
// oracle both reach in via the workspace source path (never the built dist, which the exports map blocks).
import { writeIssueFile, listIssues, computeIssueId, type Issue } from "../../core/src/optimize/substrate/issues.js";

// `GET /__piflow/issues/<run>?node=<id>` (M8.2) is the run-digest route's twin: it resolves the run's
// TEMPLATE dir (via `templateDirFor`, the same helper `node-config`/`node-edit` already use) and projects
// the optimize-substrate issue LEDGER through core's `nodeIssuesProjection` — a thin wrapper over
// `listIssues`. Here we prove only the WIRING (the projection itself is covered by
// packages/core/test/observe-issues.test.ts): the route matches, a missing `?node=` 400s, an unresolved
// run/template 404s, the node filter is honored, and the body is byte-for-byte what `listIssues` returns
// (so returning ALL nodes' issues, dropping the node filter, or mis-resolving the template dir all turn
// this RED).

// resolveRunDir is the run-dir lookup templateDirFor sits on top of; make it settable per test (same
// mocking convention as run-digest-endpoint.test.ts).
let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowNodeIssues } = await import("../src/handlers.js");

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "piflow-issues-endpoint-"));
  runDirStub = null;
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** Drive a middleware with a fake req/res; resolves with {status, json}, rejects if the route falls through. */
function call(
  handler: typeof piflowNodeIssues,
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

function makeIssue(node: string, tag: string, overrides: Partial<Issue> = {}): Issue {
  const sig = `${node}::${tag}`;
  return {
    id: computeIssueId(node, sig),
    name: tag,
    title: `issue: ${tag}`,
    severity: "high",
    status: "open",
    reason: null,
    sig,
    firstSeen: "260706-01",
    lastSeen: "260706-01",
    attempts: [],
    body: `context brief for ${tag}\n`,
    ...overrides,
  };
}

/** `<repo>/.piflow/<wf>/{runs/<id>,template}` — the canonical sibling layout `templateDirFor` expects. */
function fixtureLayout(): { repo: string; runDir: string; templateDir: string } {
  const repo = join(scratch, "repo");
  const runDir = join(repo, ".piflow", "lesson-build", "runs", "flaky-pecan");
  const templateDir = join(repo, ".piflow", "lesson-build", "template");
  mkdirSync(runDir, { recursive: true });
  return { repo, runDir, templateDir };
}

describe("issues endpoint", () => {
  it("returns exactly listIssues(templateDir, {node}) for the requested node", async () => {
    const { runDir, templateDir } = fixtureLayout();
    await writeIssueFile(join(templateDir, "nodes", "gameplay", "issues", "soggy-crust.md"), makeIssue("gameplay", "soggy-crust", { severity: "critical" }));
    await writeIssueFile(join(templateDir, "nodes", "gameplay", "issues", "slow-compose.md"), makeIssue("gameplay", "slow-compose", { severity: "medium" }));
    await writeIssueFile(join(templateDir, "nodes", "research", "issues", "stale-cache.md"), makeIssue("research", "stale-cache"));
    runDirStub = { runDir, workspaceRoot: null, historyDirs: [] };

    const { status, json } = await call(piflowNodeIssues, { method: "GET", url: "/__piflow/issues/flaky-pecan?node=gameplay" });

    const expected = await listIssues(templateDir, { node: "gameplay" });
    expect(status).toBe(200);
    expect(json).toEqual(JSON.parse(JSON.stringify(expected)));
    // node filter honored — the 'research' issue never leaks in, and both gameplay issues are present.
    const rows = json as Array<{ node: string; issue: { name: string } }>;
    expect(rows.every((r) => r.node === "gameplay")).toBe(true);
    expect(rows.map((r) => r.issue.name)).toEqual(["soggy-crust", "slow-compose"]); // severity-desc
  });

  it("returns the run-LEVEL aggregate (every node's issues) when ?node= is omitted", async () => {
    const { runDir, templateDir } = fixtureLayout();
    await writeIssueFile(join(templateDir, "nodes", "gameplay", "issues", "soggy-crust.md"), makeIssue("gameplay", "soggy-crust", { severity: "critical" }));
    await writeIssueFile(join(templateDir, "nodes", "research", "issues", "stale-cache.md"), makeIssue("research", "stale-cache"));
    runDirStub = { runDir, workspaceRoot: null, historyDirs: [] };

    const { status, json } = await call(piflowNodeIssues, { method: "GET", url: "/__piflow/issues/flaky-pecan" });

    expect(status).toBe(200); // no longer a 400 — the aggregate is a first-class view
    const rows = json as Array<{ node: string; issue: { name: string } }>;
    // both nodes contribute — the run-level card is 'characterized by node' across the whole template.
    expect(new Set(rows.map((r) => `${r.node}/${r.issue.name}`))).toEqual(
      new Set(["gameplay/soggy-crust", "research/stale-cache"]),
    );
  });

  it("404s when the run does not resolve", async () => {
    runDirStub = null;
    const { status, json } = await call(piflowNodeIssues, { method: "GET", url: "/__piflow/issues/nope?node=gameplay" });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/no run "nope"/);
  });

  it("404s when the run resolves but carries no template (canonical <wf>/template layout missing)", async () => {
    // a run dir with NO sibling ../../template — templateDirFor's second 404 branch.
    const runDir = join(scratch, "orphan-run");
    mkdirSync(runDir, { recursive: true });
    runDirStub = { runDir, workspaceRoot: null, historyDirs: [] };
    const { status, json } = await call(piflowNodeIssues, { method: "GET", url: "/__piflow/issues/flaky-pecan?node=gameplay" });
    expect(status).toBe(404);
    expect((json as { error: string }).error).toMatch(/no template/);
  });

  it("falls through (next) when the URL is not an issues route", async () => {
    await expect(call(piflowNodeIssues, { method: "GET", url: "/__piflow/run-view/x" })).rejects.toThrow("route did not match");
  });
});

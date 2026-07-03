import { describe, it, expect } from "vitest";
import {
  deriveWorkspaces,
  homeWorkspace,
  pickCurrentRun,
  pickRunForWorkspace,
  workspaceOfRun,
  type GlobalIndex,
  type IndexThread,
  type IndexProduct,
} from "./runIndex";

// A minimal IndexThread factory — only the fields the workspace selectors read matter; the rest are filled
// with inert defaults so the fixtures stay readable. `state`/`updatedAt`/`viewable`/`run` are what we assert on.
function thread(run: string, over: Partial<IndexThread> = {}): IndexThread {
  return {
    run,
    runDir: `/x/${run}`,
    state: "done",
    done: true,
    ok: true,
    stageIndex: null,
    stageTotal: null,
    phase: null,
    runningNode: null,
    runningTool: null,
    staleMs: null,
    runningStalled: false,
    nodesDone: 0,
    nodesTotal: 0,
    frac: 0,
    elapsedMs: null,
    updatedAt: null,
    provider: null,
    model: null,
    errorNode: null,
    runViewPath: `runs/${run}/run-view.json`,
    viewable: true,
    ...over,
  };
}

function product(id: string, threads: IndexThread[], nsCount = 1): IndexProduct {
  // spread `threads` across `nsCount` namespaces so templateCount is exercised independently of runCount.
  const namespaces = Array.from({ length: nsCount }, (_, i) => ({
    id: `${id}-ns${i}`,
    name: `${id} template ${i}`,
    threads: i === 0 ? threads : [],
  }));
  return { id, name: id, root: `/repos/${id}`, namespaces };
}

function index(products: IndexProduct[]): GlobalIndex {
  return { generatedAt: "2026-07-03T00:00:00Z", products };
}

describe("deriveWorkspaces — one card per folder, recents-first", () => {
  it("counts templates + runs + running, and picks the folder's most-recent updatedAt", () => {
    const ix = index([
      product(
        "alpha",
        [thread("a1", { state: "done", updatedAt: "2026-07-01T10:00:00Z" }), thread("a2", { state: "running", updatedAt: "2026-07-02T10:00:00Z" })],
        3, // 3 templates, runs only under the first
      ),
    ]);
    const [alpha] = deriveWorkspaces(ix);
    expect(alpha.templateCount).toBe(3);
    expect(alpha.runCount).toBe(2);
    expect(alpha.runningCount).toBe(1);
    expect(alpha.lastUpdatedAt).toBe("2026-07-02T10:00:00Z");
    expect(alpha.root).toBe("/repos/alpha");
  });

  it("orders: folders with a live run first, then most-recently-active, then alphabetical", () => {
    const ix = index([
      product("zeta", [thread("z1", { updatedAt: "2026-07-01T00:00:00Z" })]), // dated, no live
      product("beta", [thread("b1", { state: "running", updatedAt: "2026-06-01T00:00:00Z" })]), // live (oldest date, but wins)
      product("acme", [thread("c1", { updatedAt: "2026-07-02T00:00:00Z" })]), // newest dated, no live
    ]);
    expect(deriveWorkspaces(ix).map((w) => w.id)).toEqual(["beta", "acme", "zeta"]);
  });

  it("marks a folder non-viewable only when NONE of its runs are viewable", () => {
    const ix = index([
      product("mixed", [thread("m1", { viewable: false }), thread("m2", { viewable: true })]),
      product("foreign", [thread("f1", { viewable: false })]),
    ]);
    const cards = deriveWorkspaces(ix);
    expect(cards.find((w) => w.id === "mixed")?.viewable).toBe(true);
    expect(cards.find((w) => w.id === "foreign")?.viewable).toBe(false);
  });
});

describe("pickRunForWorkspace — scoped focus (running > newest > last), never crosses folders", () => {
  const ix = index([
    product("alpha", [
      thread("a-old", { state: "done", updatedAt: "2026-07-01T00:00:00Z" }),
      thread("a-live", { state: "running", updatedAt: "2026-06-01T00:00:00Z" }),
    ]),
    product("beta", [thread("b-new", { state: "done", updatedAt: "2026-07-09T00:00:00Z" })]),
    product("empty", []),
  ]);

  it("prefers a running run in the folder even if another folder is newer", () => {
    expect(pickRunForWorkspace(ix, "alpha")).toBe("a-live");
  });
  it("falls back to the folder's newest when none run", () => {
    expect(pickRunForWorkspace(ix, "beta")).toBe("b-new");
  });
  it("returns null for an empty folder or an unknown id", () => {
    expect(pickRunForWorkspace(ix, "empty")).toBeNull();
    expect(pickRunForWorkspace(ix, "nope")).toBeNull();
  });
  it("does NOT leak the global pick: alpha's running run is not beta's newest", () => {
    // pickCurrentRun (global) would return alpha's running run; per-workspace beta must stay b-new.
    expect(pickCurrentRun(ix)).toBe("a-live");
    expect(pickRunForWorkspace(ix, "beta")).toBe("b-new");
  });
});

describe("workspaceOfRun — which folder owns a run", () => {
  const ix = index([product("alpha", [thread("a1")]), product("beta", [thread("b1")])]);
  it("finds the owning product id", () => {
    expect(workspaceOfRun(ix, "b1")).toBe("beta");
  });
  it("returns null for a run not in the index", () => {
    expect(workspaceOfRun(ix, "ghost")).toBeNull();
  });
});

describe("homeWorkspace — biases initial focus to the launched folder", () => {
  const ix = index([product("alpha", [thread("a1")]), product("beta", [thread("b1")])]);
  it("matches a product by its root (trailing-slash insensitive)", () => {
    expect(homeWorkspace(ix, ["/repos/beta"])).toBe("beta");
    expect(homeWorkspace(ix, ["/repos/beta/"])).toBe("beta");
  });
  it("returns null when no root matches or none is given (raw dev)", () => {
    expect(homeWorkspace(ix, ["/repos/other"])).toBeNull();
    expect(homeWorkspace(ix, [])).toBeNull();
  });
});

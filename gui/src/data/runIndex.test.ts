import { describe, it, expect } from "vitest";
import {
  deriveWorkspaces,
  homeWorkspace,
  indexToTree,
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

// A hand-built index (not the generic `product()`/`thread()` factories) so a namespace's id/name and each
// thread's state/updatedAt are fully explicit — the exact shape indexToTree's scoping + sort read.
function treeIndex(): GlobalIndex {
  return index([
    {
      id: "alpha",
      name: "alpha",
      root: "/repos/alpha",
      namespaces: [
        {
          id: "gmA",
          name: "Game Omni", // display name DIFFERS from the dir id
          threads: [
            thread("r-done-old", { state: "done", updatedAt: "2026-07-01T00:00:00Z" }),
            thread("r-null", { state: "done", updatedAt: null }),
            thread("r-running", { state: "running", updatedAt: "2026-07-02T00:00:00Z" }), // older than r-done-new
            thread("r-done-new", { state: "done", updatedAt: "2026-07-03T00:00:00Z" }),
          ],
        },
      ],
    },
    {
      id: "beta",
      name: "beta",
      root: "/repos/beta",
      namespaces: [{ id: "beta-ns", name: "beta-ns", threads: [thread("b1")] }], // display name === dir id
    },
  ]);
}

describe("indexToTree — workspace-scoped root column (M5)", () => {
  it("scopes the root column to ONLY the given workspace's namespaces", () => {
    const { tree } = indexToTree(treeIndex(), "alpha");
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe("n:alpha/gmA");
  });

  it("never leaks another workspace's namespace into the scoped tree", () => {
    const { tree } = indexToTree(treeIndex(), "alpha");
    expect(tree.some((n) => n.id.startsWith("n:beta/"))).toBe(false);
  });

  it("falls back to ALL products when productId is null (never an empty switcher)", () => {
    const { tree } = indexToTree(treeIndex(), null);
    expect(tree.map((n) => n.id).sort()).toEqual(["n:alpha/gmA", "n:beta/beta-ns"]);
  });

  it("falls back to ALL products when productId matches no registered workspace", () => {
    const { tree } = indexToTree(treeIndex(), "no-such-workspace");
    expect(tree.map((n) => n.id).sort()).toEqual(["n:alpha/gmA", "n:beta/beta-ns"]);
  });

  it("sorts threads: running first, then updatedAt desc, null updatedAt last", () => {
    const { tree } = indexToTree(treeIndex(), "alpha");
    expect(tree[0].children?.map((c) => c.name)).toEqual(["r-running", "r-done-new", "r-done-old", "r-null"]);
  });

  it("passes the dir id through as a secondary label ONLY when it differs from the display name", () => {
    const { tree } = indexToTree(treeIndex(), null);
    const alphaNs = tree.find((n) => n.id === "n:alpha/gmA")!;
    const betaNs = tree.find((n) => n.id === "n:beta/beta-ns")!;
    expect(alphaNs.name).toBe("Game Omni");
    expect(alphaNs.secondaryLabel).toBe("gmA"); // name ("Game Omni") !== dir id ("gmA")
    expect(betaNs.secondaryLabel).toBeUndefined(); // name === dir id — nothing extra to disambiguate
  });

  it("resolve() still maps a leaf id back to its run + owning product/namespace", () => {
    const { tree, resolve } = indexToTree(treeIndex(), "alpha");
    const leafId = tree[0].children?.[0]?.id;
    expect(leafId).toBeTruthy();
    expect(resolve(leafId!)).toEqual({ run: "r-running", viewable: true, productId: "alpha", nsId: "gmA" });
  });
});

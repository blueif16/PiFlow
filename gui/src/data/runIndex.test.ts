import { describe, it, expect } from "vitest";
import {
  deriveWorkspaces,
  homeWorkspace,
  indexToTree,
  pickCurrentRun,
  pickRunForWorkspace,
  sortThreads,
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
    orphaned: false,
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
    expect(resolve(leafId!)).toEqual({ run: "r-running", viewable: true, productId: "alpha", nsId: "gmA", kind: "run" });
  });

  // T1 — every run leaf carries the index thread fields VERBATIM (the GUI computes nothing) so the
  // DirectoryPanel can render the progress cluster from them alone. Fails if any field is dropped,
  // renamed, or re-derived.
  it("fills each run leaf's `run` field verbatim from the thread (state · ok · frac · nodesDone/nodesTotal)", () => {
    const ix = index([
      {
        id: "alpha",
        name: "alpha",
        root: "/repos/alpha",
        namespaces: [
          {
            id: "wf",
            name: "wf",
            threads: [thread("r1", { state: "running", ok: null, frac: 3 / 9, nodesDone: 3, nodesTotal: 9 })],
          },
        ],
      },
    ]);
    const { tree } = indexToTree(ix, "alpha");
    expect(tree[0].children?.[0]?.run).toEqual({ state: "running", ok: null, frac: 3 / 9, done: 3, total: 9 });
  });

  // A run whose controller process died reads `state:"failed"` (see discover.ts's orphaned override) —
  // but the row must say WHY, not just "failed" like a genuine reported error, so `typeLabel` distinguishes
  // it. Fails if `orphaned` is dropped on the floor the way `staleMs`/`runningStalled` used to be.
  it("labels an orphaned run's leaf 'killed' instead of its raw state", () => {
    const ix = index([
      {
        id: "alpha",
        name: "alpha",
        root: "/repos/alpha",
        namespaces: [
          {
            id: "wf",
            name: "wf",
            threads: [
              thread("r-orphaned", { state: "failed", orphaned: true }),
              thread("r-genuine-fail", { state: "failed", orphaned: false }),
            ],
          },
        ],
      },
    ]);
    const { tree } = indexToTree(ix, "alpha");
    const byName = new Map(tree[0].children?.map((c) => [c.name, c.typeLabel]));
    expect(byName.get("r-orphaned")).toBe("killed");
    expect(byName.get("r-genuine-fail")).toBe("failed");
  });

  it("orders leaves by the requested sort mode (name mode reorders what time mode built)", () => {
    const byName = indexToTree(treeIndex(), "alpha", "name");
    expect(byName.tree[0].children?.map((c) => c.name)).toEqual(["r-done-new", "r-done-old", "r-null", "r-running"]);
  });
});

// The pinned "Template" row — the canonical workflow, no run needed. Present whenever the namespace has an
// authored template on disk (`templatePath`), even with zero runs; absent for a template-less namespace.
function templatedIndex(): GlobalIndex {
  return index([
    {
      id: "alpha",
      name: "alpha",
      root: "/repos/alpha",
      namespaces: [
        {
          id: "gmA",
          name: "Game Omni",
          templatePath: "/repos/alpha/.piflow/gmA/template/meta.json",
          threads: [thread("r1", { state: "done", updatedAt: "2026-07-01T00:00:00Z" })],
        },
      ],
    },
  ]);
}

describe("indexToTree — pinned Template row (no run needed)", () => {
  it("prepends a pinned Template leaf ahead of every run leaf", () => {
    const { tree } = indexToTree(templatedIndex(), "alpha");
    const children = tree[0].children ?? [];
    expect(children[0]?.name).toBe("Template");
    expect(children[0]?.pinned).toBe(true);
    expect(children.slice(1).map((c) => c.name)).toEqual(["r1"]);
  });

  it('resolve() maps the Template leaf to its owning product/namespace with kind "template"', () => {
    const { tree, resolve } = indexToTree(templatedIndex(), "alpha");
    const tplId = tree[0].children?.[0]?.id;
    expect(tplId).toBeTruthy();
    expect(resolve(tplId!)).toEqual({ run: tplId, viewable: true, productId: "alpha", nsId: "gmA", kind: "template" });
  });

  it("omits the pinned row entirely for a template-less namespace (runs-only, no templatePath)", () => {
    const { tree } = indexToTree(treeIndex(), "alpha"); // treeIndex()'s namespace sets no templatePath
    expect(tree[0].children?.every((c) => !c.pinned)).toBe(true);
  });

  it("stands up even with ZERO runs — the whole reason to pin it", () => {
    const ix = index([
      { id: "alpha", name: "alpha", root: "/repos/alpha", namespaces: [{ id: "gmA", name: "Game Omni", templatePath: "/repos/alpha/.piflow/gmA/template/meta.json", threads: [] }] },
    ]);
    const { tree } = indexToTree(ix, "alpha");
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children?.[0]?.name).toBe("Template");
  });
});

// T2 — the PURE thread-order selector behind the switcher's sort control. One test per mode, each
// pinned so reverting that mode's comparator (or collapsing modes into one) fails it.
describe("sortThreads — the switcher's sort modes", () => {
  const threads = () => [
    thread("m-done-old", { state: "done", updatedAt: "2026-07-01T00:00:00Z" }),
    thread("a-null", { state: "done", updatedAt: null }),
    thread("z-running", { state: "running", updatedAt: "2026-07-02T00:00:00Z" }),
    thread("b-failed", { state: "failed", ok: false, updatedAt: "2026-06-01T00:00:00Z" }),
    thread("k-done-new", { state: "done", updatedAt: "2026-07-03T00:00:00Z" }),
  ];

  it("time (default): running first, then updatedAt desc, null updatedAt last", () => {
    expect(sortThreads(threads(), "time").map((t) => t.run)).toEqual([
      "z-running", // running always leads
      "k-done-new", // 07-03
      "m-done-old", // 07-01
      "b-failed", // 06-01
      "a-null", // no date → last
    ]);
  });

  it("name: plain A–Z by run id, ignoring state and dates entirely", () => {
    expect(sortThreads(threads(), "name").map((t) => t.run)).toEqual([
      "a-null",
      "b-failed",
      "k-done-new",
      "m-done-old",
      "z-running",
    ]);
  });

  it("status: running → failed → done (newest first inside each group)", () => {
    expect(sortThreads(threads(), "status").map((t) => t.run)).toEqual([
      "z-running", // group 1: running
      "b-failed", // group 2: failed
      "k-done-new", // group 3: done, newest first…
      "m-done-old",
      "a-null", // …null date last
    ]);
  });

  it("never mutates the input array", () => {
    const input = threads();
    const before = input.map((t) => t.run);
    sortThreads(input, "name");
    expect(input.map((t) => t.run)).toEqual(before);
  });
});

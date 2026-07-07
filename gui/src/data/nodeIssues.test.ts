import { describe, it, expect } from "vitest";
import { sortIssues, isCurrentRun, isClosed, issueCounts, groupByNode, type IssueRecord, type Issue, type Severity, type Status } from "./nodeIssues";

// A minimal Issue factory — only the fields the sort/badge predicates read matter; the rest are inert.
function issue(name: string, over: Partial<Issue> = {}): Issue {
  return {
    id: `sha256:${name}`,
    name,
    title: `issue: ${name}`,
    severity: "medium" as Severity,
    status: "open",
    reason: null,
    sig: `gameplay::${name}`,
    firstSeen: "260706-01",
    lastSeen: "260706-01",
    attempts: [],
    body: "",
    ...over,
  };
}
function record(name: string, over: Partial<Issue> = {}): IssueRecord {
  return { node: "gameplay", file: `/nodes/gameplay/issues/${name}.md`, issue: issue(name, over) };
}

describe("sortIssues", () => {
  it("orders severity DESC, then firstSeen ASC within a severity — mirrors core's listIssues order", () => {
    const records = [
      record("low-old", { severity: "low", firstSeen: "260701-01" }),
      record("critical-new", { severity: "critical", firstSeen: "260706-02" }),
      record("high-b", { severity: "high", firstSeen: "260706-02" }),
      record("critical-old", { severity: "critical", firstSeen: "260706-01" }),
      record("high-a", { severity: "high", firstSeen: "260706-01" }),
    ];

    const sorted = sortIssues(records);

    expect(sorted.map((r) => r.issue.name)).toEqual([
      "critical-old", // critical, earliest firstSeen first
      "critical-new",
      "high-a",       // high, earliest firstSeen first
      "high-b",
      "low-old",
    ]);
  });

  it("does not mutate the input array (returns a new one)", () => {
    const records = [record("a", { severity: "low" }), record("b", { severity: "critical" })];
    const original = [...records];
    sortIssues(records);
    expect(records).toEqual(original); // input order untouched
  });
});

describe("isCurrentRun", () => {
  it("badges a row whose firstSeen IS the viewed run", () => {
    expect(isCurrentRun(record("a", { firstSeen: "260706-01", lastSeen: "260706-03" }), "260706-01")).toBe(true);
  });

  it("badges a row whose lastSeen IS the viewed run", () => {
    expect(isCurrentRun(record("a", { firstSeen: "260701-01", lastSeen: "260706-01" }), "260706-01")).toBe(true);
  });

  it("badges a row whose attempts[].verifiedByRun matches the viewed run", () => {
    const r = record("a", { firstSeen: "260701-01", lastSeen: "260701-01", attempts: [{ commit: "c1", verifiedByRun: "260706-01" }] });
    expect(isCurrentRun(r, "260706-01")).toBe(true);
  });

  it("badges a row whose attempts[].regressedIn matches the viewed run", () => {
    const r = record("a", {
      firstSeen: "260701-01", lastSeen: "260701-01",
      attempts: [{ commit: "c1", verifiedByRun: "260701-02", regressedIn: "260706-01" }],
    });
    expect(isCurrentRun(r, "260706-01")).toBe(true);
  });

  it("does NOT badge a row with no reference to the viewed run", () => {
    const r = record("a", { firstSeen: "260701-01", lastSeen: "260701-02", attempts: [{ commit: "c1", verifiedByRun: "260701-03" }] });
    expect(isCurrentRun(r, "260706-01")).toBe(false);
  });
});

// The GitHub-issues status model: an issue is CLOSED only when it is `resolved`; every other status
// (open/active/fix-landed/verifying — and a reopened `regressed`) counts as OPEN. This is the single
// mapping the count cluster + the panels read, so it is pinned here rather than inlined per-component.
describe("isClosed", () => {
  it("is closed ONLY for the resolved status", () => {
    expect(isClosed("resolved")).toBe(true);
  });

  it("is open for every non-resolved status, including a reopened regressed issue", () => {
    const openStatuses: Status[] = ["open", "active", "fix-landed", "verifying", "regressed"];
    for (const s of openStatuses) expect(isClosed(s)).toBe(false);
  });
});

describe("issueCounts", () => {
  it("counts resolved as closed and everything else as open", () => {
    const records = [
      record("a", { status: "open" }),
      record("b", { status: "regressed" }),   // reopened → open
      record("c", { status: "resolved", reason: "fixed" }),
      record("d", { status: "verifying" }),
    ];
    expect(issueCounts(records)).toEqual({ open: 3, closed: 1 });
  });

  it("open + closed always equals the record count (no row is dropped or double-counted)", () => {
    const records = [
      record("a", { status: "resolved", reason: "fixed" }),
      record("b", { status: "resolved", reason: "wontfix" }),
      record("c", { status: "active" }),
    ];
    const { open, closed } = issueCounts(records);
    expect(open + closed).toBe(records.length);
    expect(closed).toBe(2);
  });

  it("is {open:0, closed:0} for an empty ledger", () => {
    expect(issueCounts([])).toEqual({ open: 0, closed: 0 });
  });
});

describe("groupByNode", () => {
  it("groups records by node, orders groups worst-severity-first then node-name, sorts within each group", () => {
    const records: IssueRecord[] = [
      { node: "gameplay", file: "f", issue: issue("g-med", { severity: "medium", firstSeen: "260701-02" }) },
      { node: "w1-design", file: "f", issue: issue("d-crit", { severity: "critical", firstSeen: "260701-01" }) },
      { node: "gameplay", file: "f", issue: issue("g-high", { severity: "high", firstSeen: "260701-01" }) },
      { node: "w1-design", file: "f", issue: issue("d-low", { severity: "low", firstSeen: "260701-03" }) },
    ];

    const groups = groupByNode(records);

    // w1-design owns the critical → it leads; gameplay (top severity high) follows.
    expect(groups.map((g) => g.node)).toEqual(["w1-design", "gameplay"]);
    // within a group: severity DESC then firstSeen ASC (sortIssues order)
    expect(groups[0].records.map((r) => r.issue.name)).toEqual(["d-crit", "d-low"]);
    expect(groups[1].records.map((r) => r.issue.name)).toEqual(["g-high", "g-med"]);
  });

  it("preserves every record exactly once (partition, not filter)", () => {
    const records: IssueRecord[] = [
      { node: "a", file: "f", issue: issue("x") },
      { node: "b", file: "f", issue: issue("y") },
      { node: "a", file: "f", issue: issue("z") },
    ];
    const groups = groupByNode(records);
    const flat = groups.flatMap((g) => g.records);
    expect(flat).toHaveLength(records.length);
    expect(new Set(flat.map((r) => r.issue.name))).toEqual(new Set(["x", "y", "z"]));
  });

  it("breaks a group-order tie (equal top severity) by node name ascending", () => {
    const records: IssueRecord[] = [
      { node: "zebra", file: "f", issue: issue("z1", { severity: "high" }) },
      { node: "alpha", file: "f", issue: issue("a1", { severity: "high" }) },
    ];
    expect(groupByNode(records).map((g) => g.node)).toEqual(["alpha", "zebra"]);
  });
});

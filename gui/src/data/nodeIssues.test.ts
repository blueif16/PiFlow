import { describe, it, expect } from "vitest";
import { sortIssues, isCurrentRun, type IssueRecord, type Issue, type Severity } from "./nodeIssues";

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

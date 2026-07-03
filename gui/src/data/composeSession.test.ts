// composeSession — the PURE compose-agent contract behind Slice 2 (NL → agent-composed gate). Three
// load-bearing decisions, each unit-tested so a break FAILS here:
//   - isAgentComposed(kind): which gate kinds go through the composing agent vs the fast-path direct write.
//   - buildComposeBundle(...): the outbound message that BUNDLES the context the agent needs (inv 2) — node,
//     kind (user vocabulary), the user's text VERBATIM, prev/next neighbors, where the run + template live,
//     and the strict output contract. A break here starves the agent of context.
//   - extractGateChip(agentText, kind): turn the agent's streamed reply into the validated GateChip the run-
//     first bake lands — NEVER trusting a prose "I created it" claim (inv 5). No parseable chip ⇒ null ⇒ the
//     card lands nothing and stays honest.
import { describe, it, expect } from "vitest";
import { isAgentComposed, buildComposeBundle, extractGateChip } from "./composeSession";
import { JUDGE_DEFAULT_TIER } from "./gates";

describe("isAgentComposed — fast-path vs agent (inv 7)", () => {
  it("routes agentic check (judge) and execution through the agent", () => {
    expect(isAgentComposed("judge")).toBe(true);
    expect(isAgentComposed("execution")).toBe(true);
  });
  it("routes a human checkpoint to the fast-path (no agent)", () => {
    expect(isAgentComposed("human")).toBe(false);
  });
});

describe("buildComposeBundle — the context bundle (inv 2)", () => {
  const bundle = buildComposeBundle({
    kind: "judge",
    nodeId: "synthesize",
    text: "A good synthesis cites every source and never invents a statistic.",
    prev: ["research", "collect"],
    next: ["author"],
  });

  it("names the target node", () => {
    expect(bundle).toContain("synthesize");
  });
  it("names the gate kind in USER vocabulary + its plain meaning (not bare internal jargon)", () => {
    expect(bundle.toLowerCase()).toContain("agentic check");
    expect(bundle).toContain("verifies"); // the plain-language meaning, so the agent understands the intent
  });
  it("carries the user's description VERBATIM (the agent must see the exact words)", () => {
    expect(bundle).toContain("A good synthesis cites every source and never invents a statistic.");
  });
  it("carries the upstream and downstream neighbors", () => {
    expect(bundle).toContain("research");
    expect(bundle).toContain("collect");
    expect(bundle).toContain("author");
  });
  it("tells the agent where the run + template live (cwd + node.json path)", () => {
    // the compose pi runs at cwd = the run dir; the template is the canonical sibling; the node.json path is exact.
    expect(bundle).toContain("../../template/nodes/synthesize/node.json");
  });
  it("states the strict output contract — a single fenced json chip block", () => {
    expect(bundle).toContain("```json");
    expect(bundle.toLowerCase()).toContain("kind");
  });
  it("has NO neighbor phrasing when a node is isolated (no invented neighbors)", () => {
    const solo = buildComposeBundle({ kind: "execution", nodeId: "only", text: "npm test passes", prev: [], next: [] });
    expect(solo).toContain("only");
    expect(solo).not.toContain("undefined");
    expect(solo).not.toContain("research");
  });
});

describe("extractGateChip — the agent's reply → a validated chip, never a trusted claim (inv 5)", () => {
  it("pulls a judge chip from a fenced json block, carrying the rubric verbatim", () => {
    const reply = [
      "I inspected the node and turned your description into a concrete rubric.",
      "```json",
      '{ "kind": "judge", "rubric": "Cites every source; invents no statistic.", "judgeTier": "deep", "threshold": "pass", "retryMax": 2 }',
      "```",
    ].join("\n");
    const chip = extractGateChip(reply, "judge");
    expect(chip).toEqual({ kind: "judge", rubric: "Cites every source; invents no statistic.", judgeTier: "deep", threshold: "pass", retryMax: 2 });
  });

  it("pulls an execution chip (cmd + policy) from a fenced json block", () => {
    const reply = "Here is the gate.\n```json\n{ \"kind\": \"execution\", \"cmd\": \"bash scripts/check.sh\", \"onFailure\": \"warn\" }\n```";
    expect(extractGateChip(reply, "execution")).toEqual({ kind: "execution", cmd: "bash scripts/check.sh", onFailure: "warn" });
  });

  it("FORCES the chip kind to the dropped kind even if the agent mislabels it", () => {
    const reply = '```json\n{ "kind": "human", "rubric": "must be non-empty" }\n```';
    const chip = extractGateChip(reply, "judge");
    expect(chip?.kind).toBe("judge");
    expect(chip?.rubric).toBe("must be non-empty");
  });

  it("defaults the hidden fields when the agent omits them (tier/threshold/retry)", () => {
    const chip = extractGateChip('```json\n{ "kind": "judge", "rubric": "reads naturally" }\n```', "judge");
    expect(chip).toEqual({ kind: "judge", rubric: "reads naturally", judgeTier: JUDGE_DEFAULT_TIER, retryMax: 1 });
  });

  it("returns null when the reply is prose only — an 'I created it' CLAIM lands nothing", () => {
    expect(extractGateChip("Done! I've wired up the agentic check for you.", "judge")).toBeNull();
  });

  it("returns null when the required field is missing (judge without a rubric)", () => {
    expect(extractGateChip('```json\n{ "kind": "judge", "judgeTier": "deep" }\n```', "judge")).toBeNull();
    expect(extractGateChip('```json\n{ "kind": "execution", "onFailure": "block" }\n```', "execution")).toBeNull();
  });

  it("takes the LAST valid block when the agent shows an example then the final chip", () => {
    const reply = [
      "For example an execution gate looks like:",
      '```json\n{ "kind": "execution", "cmd": "echo example" }\n```',
      "Here is the real one:",
      '```json\n{ "kind": "execution", "cmd": "pytest -q", "onFailure": "block" }\n```',
    ].join("\n");
    expect(extractGateChip(reply, "execution")).toEqual({ kind: "execution", cmd: "pytest -q", onFailure: "block" });
  });

  it("recovers a bare (unfenced) json object when the model forgets the fence", () => {
    const reply = 'The gate spec is: { "kind": "judge", "rubric": "no TODOs remain" }';
    expect(extractGateChip(reply, "judge")).toEqual({ kind: "judge", rubric: "no TODOs remain", judgeTier: JUDGE_DEFAULT_TIER, retryMax: 1 });
  });
});

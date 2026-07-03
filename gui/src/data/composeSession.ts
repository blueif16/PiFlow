// composeSession — the PURE contract for Slice 2 (natural-language → agent-composed gate). No React, no I/O,
// so every decision here is unit-testable and every surface agrees on one vocabulary.
//
// The flow: the user drops a rail gate on a node and describes it in plain language. For an AGENT-composed kind
// (agentic check / execution) the description is bundled with context and sent to a dedicated `pi` session on
// the control channel; the agent interprets it, (for execution) may author a real gating script, and emits a
// structured gate chip. This module owns the two ends of that exchange:
//   - buildComposeBundle — the OUTBOUND message that gives the agent everything it needs (inv 2), with a strict
//     fenced-json output contract at the tail (the schema boundary the reply is parsed against).
//   - extractGateChip — the INBOUND parse: the agent's streamed reply → the exact GateChip the run-first bake
//     lands. It NEVER trusts a prose "I created it" claim (inv 5) — no parseable, well-formed chip ⇒ null.
// The chip it returns is the SAME GateChip shape `buildGateChip` produces, so it flows through the identical
// validated write path (bakeNodeEditToRun) — no second, drift-prone landing mechanism.
import { RAIL_KINDS, JUDGE_DEFAULT_TIER, type RailKind } from "./gates";
import type { GateChip } from "./runView";

/** Which gate kinds are composed by the AGENT vs the fast-path direct write. A human checkpoint is a plain
 *  question — the deterministic write is honest and instant, so it skips the agent (inv 7). Agentic check and
 *  execution carry real authoring judgment (a self-contained rubric; a real gating command/script), so they go
 *  through the composing agent. */
export function isAgentComposed(kind: RailKind): boolean {
  return kind === "judge" || kind === "execution";
}

export interface ComposeBundleInput {
  kind: RailKind;
  nodeId: string;
  /** the author's plain-language description, carried VERBATIM into the bundle. */
  text: string;
  /** upstream / downstream node ids (from the run graph) — the agent's structural context. */
  prev: string[];
  next: string[];
}

/** A neighbor list phrased for the bundle, or an honest "none" (never an invented neighbor). */
function neighborLine(ids: string[], role: "upstream" | "downstream", endpoint: string): string {
  if (ids.length === 0) return `- ${role === "upstream" ? "Upstream" : "Downstream"} node(s): none (this node is a ${endpoint})`;
  return `- ${role === "upstream" ? "Upstream" : "Downstream"} node(s): ${ids.map((n) => `\`${n}\``).join(", ")}`;
}

/** The per-kind body: the plain meaning of the gate, the authoring task, and the exact chip shape to emit. */
function kindSection(kind: RailKind, nodeId: string): { meaning: string; task: string; shape: string } {
  if (kind === "execution") {
    return {
      meaning: "a script gates this node's output — the shell runs a command and its exit code is the verdict (0 = pass, non-zero = fail).",
      task:
        "Author a REAL check the shell can run and gate on. Ground it in what this node produces (read its node.json and its artifacts). " +
        "If a one-liner won't do it, WRITE the script into this run directory (e.g. `scripts/gate-" +
        nodeId +
        ".sh`), make it self-contained, and set the command to run it. Prefer tools the node's workspace already has; do not assume an install.",
      shape: '{ "kind": "execution", "cmd": "<the exact command>", "onFailure": "block" }',
    };
  }
  // judge = "agentic check"
  return {
    meaning: "an agent verifies this node's output — a verify agent reads the output and scores it against a rubric of what 'good' means.",
    task:
      "Turn the request into a concrete, SELF-CONTAINED rubric a verify agent can score without any other context. " +
      "Enumerate the specific PASS criteria for THIS node's output — each phrased so a checker can mark it PASS or FAIL — and the clear failure signatures. " +
      "Pick a judge tier (`fast` | `balanced` | `deep`; default `deep`) and a threshold (`pass` is the usual bar).",
    shape: '{ "kind": "judge", "rubric": "<the full rubric>", "judgeTier": "deep", "threshold": "pass", "retryMax": 1 }',
  };
}

/**
 * The outbound compose message (inv 2): a self-contained contract that gives the agent the node, the gate kind
 * in user vocabulary + its plain meaning, the author's request VERBATIM, the graph neighbors, where the run +
 * template live, the single authoring job, and a strict fenced-json output contract at the tail. Authored per
 * agentic-prompt-design: one job, facts injected, prose for the reasoning with the schema boundary pushed to
 * the very end (the only part a parser reads).
 */
export function buildComposeBundle({ kind, nodeId, text, prev, next }: ComposeBundleInput): string {
  const spec = RAIL_KINDS.find((r) => r.kind === kind);
  const kindName = spec?.name ?? kind;
  const { meaning, task, shape } = kindSection(kind, nodeId);
  return [
    `You are composing ONE gate for a single node in a running workflow. Your entire job is to turn the author's`,
    `plain-language request into a precise, correctly-shaped gate spec for that node — nothing else.`,
    ``,
    `## The gate`,
    `- Node: \`${nodeId}\``,
    `- Gate kind: ${kindName} — ${meaning}`,
    neighborLine(prev, "upstream", "source"),
    neighborLine(next, "downstream", "sink"),
    ``,
    `## What the author asked for (verbatim)`,
    text.trim() || "(no description given — infer a sensible default gate for this node)",
    ``,
    `## Where things live`,
    `Your working directory IS this run's directory. The node's authored config is at`,
    `\`../../template/nodes/${nodeId}/node.json\` (the canonical \`<workflow>/template\` sibling of this run).`,
    `Read it — and the node's produced artifacts under this run dir — to ground the gate in what the node actually`,
    `does. Do NOT edit node.json or the run's \`.pi/\` yourself: the harness applies the spec you emit through the`,
    `validated write path and rejects anything that doesn't fit the node schema. You MAY write helper script files`,
    `into this run directory when the gate needs one.`,
    ``,
    `## Your task`,
    task,
    ``,
    `## Output contract (required)`,
    `Briefly explain the gate you chose, then END your reply with EXACTLY ONE fenced \`\`\`json block — the gate`,
    `spec — and nothing after it. Emit ONLY the fields shown; write the rubric/command IN FULL (no placeholders,`,
    `no "…", no "etc."). The block is applied to THIS run first (visible immediately) and validated; a malformed`,
    `block is rejected and shown to the author. Shape:`,
    "```json",
    shape,
    "```",
    ``,
    `## Before you send`,
    `Check: the json block parses; it carries a NON-EMPTY required field (a full rubric / a real command); the`,
    `gate is self-contained (a checker needs nothing beyond it). Fix any failure, then send.`,
  ].join("\n");
}

// ── Inbound: the agent's reply → a validated GateChip (never a trusted claim) ────────────────────────────────

/** Every fenced code block's inner text, in order (```json … ``` or a bare ``` … ```). */
function fencedBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```(?:json|jsonc|json5)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

/** Balanced-brace scan for the LAST top-level `{…}` object in a string (the unfenced-json fallback). */
function lastBraceObject(text: string): string | null {
  let last: string | null = null;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}") { if (depth > 0) { depth--; if (depth === 0 && start >= 0) last = text.slice(start, i + 1); } }
  }
  return last;
}

/** Parse a JSON candidate into a plain object, or null (never throws). */
function parseObj(candidate: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(candidate.trim());
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Coerce a parsed object into the validated GateChip for the DROPPED kind, or null if a required field is
 *  missing. The dropped kind WINS (a mislabeled `kind` in the agent's json is corrected), and the hidden system
 *  defaults (tier/threshold/retry, on-fail policy) fill in whatever the agent omitted — the same defaults
 *  buildGateChip uses, so an agent chip lands through the identical validated bake. */
function coerceChip(obj: Record<string, unknown>, kind: RailKind): GateChip | null {
  if (kind === "execution") {
    const cmd = typeof obj.cmd === "string" ? obj.cmd.trim() : "";
    if (!cmd) return null;
    const onFailure = obj.onFailure === "warn" || obj.onFailure === "stop" ? obj.onFailure : "block";
    return { kind: "execution", cmd, onFailure };
  }
  if (kind === "judge") {
    const rubric = typeof obj.rubric === "string" ? obj.rubric : "";
    if (!rubric.trim()) return null;
    const chip: GateChip = {
      kind: "judge",
      rubric,
      judgeTier: typeof obj.judgeTier === "string" && obj.judgeTier.trim() ? obj.judgeTier : JUDGE_DEFAULT_TIER,
      retryMax: Number.isInteger(obj.retryMax) && (obj.retryMax as number) > 0 ? (obj.retryMax as number) : 1,
    };
    if (typeof obj.threshold === "string" && obj.threshold.trim()) chip.threshold = obj.threshold;
    return chip;
  }
  // human is fast-path (never agent-composed); parse defensively for completeness.
  const question = typeof obj.question === "string" ? obj.question.trim() : "";
  return { kind: "human", checkpointKind: "confirm", question: question || "Approve this node's output?" };
}

/**
 * Extract the validated GateChip from the composing agent's reply (inv 5). Scans every fenced ```json block,
 * newest-last, for one that coerces to a valid chip of the dropped kind; falls back to the last bare `{…}`
 * object if the model forgot the fence. Returns null when nothing well-formed is present — so a prose-only
 * "I created the gate" claim lands NOTHING and the card stays honest (config is the source of truth, not the
 * agent's word).
 */
export function extractGateChip(agentText: string, kind: RailKind): GateChip | null {
  const candidates = fencedBlocks(agentText);
  const bare = lastBraceObject(agentText);
  if (bare) candidates.push(bare); // fenced blocks first, then the bare fallback — so a real fenced chip wins
  // walk candidates newest-first; the LAST valid chip is the agent's final answer.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const obj = parseObj(candidates[i]);
    if (!obj) continue;
    const chip = coerceChip(obj, kind);
    if (chip) return chip;
  }
  return null;
}

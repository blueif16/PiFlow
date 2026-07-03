// gates.ts — the compose editor's PURE gate-authoring model, shared by the left-edge rail, the drop card,
// and the on-node hex icons. It maps a user's natural-language intent onto the EXACT GateChip payload the
// write-back path (`gui/scripts/lib/node-writeback.mjs` → template `node.json`) consumes, and projects an
// authored/observed gate config onto the small hexagon descriptors every surface renders. Product-agnostic,
// no React, no I/O — so it is unit-testable and every surface agrees on one vocabulary.
//
// USER VOCABULARY (never leak internal jargon like judgeTier/threshold/rubric into copy):
//   "execution"     → an agent-written script gates the output (a command; exit code is the verdict)
//   "agentic check" → a verify agent judges the output against what "good" looks like (internal kind: judge)
//   "human"         → a person approves the output before it propagates (HITL checkpoint)
import type { GateChip, GateSummary, GateSummaryEntry, AuthoredNodeConfig } from "./runView";

/** The three authorable gate kinds the rail surfaces. "judge" is the INTERNAL kind for an "agentic check". */
export type RailKind = "execution" | "judge" | "human";

/** The system-default judge tier — the tier a judge model resolves through when the user tunes nothing. The
 *  drop card hides tier/threshold/retry entirely (system defaults); "deep" is the established default the old
 *  palette also used, and is schema-valid (proven by node-writeback.test.mjs against the real nodeSchema). */
export const JUDGE_DEFAULT_TIER = "deep";
/** The fallback question for a human gate when the approver-prompt field is left empty. */
export const DEFAULT_HUMAN_QUESTION = "Approve this node's output?";

/** One entry in the rail: the authorable kind + its user-facing name, one-line description, and the drop
 *  card's textarea placeholder. Copy is deliberately jargon-free (the source of the rail hover labels). */
export interface RailKindSpec {
  kind: RailKind;
  name: string;
  desc: string;
  placeholder: string;
}

/** The rail, top-to-bottom: agentic check (flagship) · execution · human. */
export const RAIL_KINDS: readonly RailKindSpec[] = [
  {
    kind: "judge",
    name: "Agentic check",
    desc: "an agent verifies this node's output",
    placeholder: "say or paste what a good output looks like…",
  },
  {
    kind: "execution",
    name: "Execution",
    desc: "a script gates this node's output",
    placeholder: "command to run (e.g. npm test) — exit code gates the output",
  },
  {
    kind: "human",
    name: "Human",
    desc: "a person approves before the output propagates",
    placeholder: "what should the approver be asked?",
  },
];

/** True when the kind needs non-empty text to author (execution needs a command, agentic check needs the
 *  "what good looks like" text; a human gate can fall back to the default question). */
export function gateNeedsText(kind: RailKind): boolean {
  return kind !== "human";
}

/** Whether a "Create gate" is allowed for this kind + current textarea value (the card's primary-button gate).
 *  A needs-text kind requires non-empty (trimmed) text; a human gate is always allowed. */
export function canCreateGate(kind: RailKind, text: string): boolean {
  return !gateNeedsText(kind) || text.trim().length > 0;
}

/** Map the drop card's natural-language text → the GateChip the write-back path persists. The agentic-check
 *  rubric is carried VERBATIM (the field the old palette omitted → every judge drop 400'd); the command is
 *  trimmed; the human question is trimmed and falls back to the default. tier/threshold/retry are the hidden
 *  system defaults. Caller gates required-field emptiness via `canCreateGate` before calling this. */
export function buildGateChip(kind: RailKind, text: string): GateChip {
  switch (kind) {
    case "execution":
      return { kind: "execution", cmd: text.trim(), onFailure: "block" };
    case "judge":
      return { kind: "judge", rubric: text, judgeTier: JUDGE_DEFAULT_TIER, threshold: "pass", retryMax: 1 };
    case "human":
      return { kind: "human", checkpointKind: "confirm", question: text.trim() || DEFAULT_HUMAN_QUESTION };
  }
}

// ── Gate → hexagon projection (one visual vocabulary for the rail, the node icons, and the HUD) ──────────
/** The policy tone a gate hexagon is tinted by — mirrors the gates.css `data-tone` vocabulary (severity at a
 *  glance: block=red, warn=amber, retry=blue, escalate=violet, human=violet, muted=advisory, ok=neutral). */
export type GateTone = "block" | "warn" | "retry" | "escalate" | "human" | "muted" | "ok";

/** The glyph a gate hexagon draws — the union across observed + authored gates (the rail exposes only the
 *  three authorable ones: execution/judge/human). */
export type GateGlyphKind = "execution" | "judge" | "human" | "check" | "retry" | "escalate" | "notify";

/** One on-node/HUD hexagon: the glyph, its policy tone, and a legible label (title/aria). */
export interface GateHexDesc {
  glyph: GateGlyphKind;
  tone: GateTone;
  label: string;
}

/** An on-fail policy → its tone (block/stop→block, warn→warn, retry→retry, escalate→escalate; default block). */
function onFailTone(onFailure?: string): GateTone {
  if (onFailure === "warn") return "warn";
  if (onFailure === "retry") return "retry";
  if (onFailure === "escalate") return "escalate";
  return "block"; // block | stop | undefined
}

/** The tone for an OBSERVED gate entry (mirrors the prior NodeGates.toneFor — policy first, then kind). */
export function observedTone(e: GateSummaryEntry): GateTone {
  if (e.advisory) return "muted";
  if (e.onFail) {
    if (e.onFail === "block" || e.onFail === "stop") return "block";
    if (e.onFail === "warn") return "warn";
    if (e.onFail === "retry") return "retry";
    if (e.onFail === "escalate") return "escalate";
  }
  if (e.kind === "reroute" || e.kind === "retry") return "retry";
  if (e.kind === "escalate") return "escalate";
  if (e.kind === "human") return "human";
  if (e.kind === "notify") return "muted";
  return "ok";
}

/** OBSERVED gate entry kind → the glyph it draws (exec→execution robot, judge→agent scales, human→person, …). */
function observedGlyph(kind: GateSummaryEntry["kind"]): GateGlyphKind {
  switch (kind) {
    case "exec": return "execution";
    case "judge": return "judge";
    case "human": return "human";
    case "reroute":
    case "retry": return "retry";
    case "escalate": return "escalate";
    case "notify": return "notify";
    case "check":
    default: return "check";
  }
}

/** Project a node's OBSERVED post-node consequence chain (run-view `config.gates`) → the hexagon row. Honest
 *  projection of config — never invents an entry. */
export function observedGateHexes(gates: GateSummary | undefined | null): GateHexDesc[] {
  if (!gates) return [];
  return gates.entries.map((e) => ({ glyph: observedGlyph(e.kind), tone: observedTone(e), label: e.label }));
}

/** Project a node's AUTHORED template config (op[] + checkpoint, from `/node-config`) → the hexagon row the
 *  compose editor shows on the node. Mirrors `gatePipelineLabels` but carries glyph + tone so the pipeline
 *  reads as the same hex vocabulary as the observed row. A landed gate is visibly present immediately. */
export function authoredGateHexes(cfg: AuthoredNodeConfig | null | undefined): GateHexDesc[] {
  if (!cfg) return [];
  const hexes: GateHexDesc[] = [];
  for (const op of cfg.op ?? []) {
    if (op.run) hexes.push({ glyph: "execution", tone: onFailTone(op.onFailure), label: "execution" });
    else if (op.gate) hexes.push({ glyph: "check", tone: op.gate.advisory ? "muted" : onFailTone(op.onFailure), label: `check: ${op.gate.kind ?? "?"}` });
    else if (op.action?.kind === "rerouteTo") hexes.push({ glyph: "judge", tone: "retry", label: "agentic check" });
    else if (op.action?.kind) hexes.push({ glyph: "check", tone: "ok", label: op.action.kind });
  }
  if (cfg.checkpoint) hexes.push({ glyph: "human", tone: "human", label: "human" });
  return hexes;
}

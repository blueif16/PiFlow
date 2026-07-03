// agentChips.ts — the basis editor's PURE agent-reassignment model (the AgentRail drag source, the
// on-node drop slot, and the AgentDropCard). Product-agnostic, no React, no I/O — the twin of gates.ts
// for the "reassign a node's base agent" flow. It pins the EXACT chip payload the write-back path
// (`gui/scripts/lib/node-writeback.mjs` → template `node.json.agentType`) consumes.
import type { AgentCatalog } from "./runView";

/** The MIME the AgentRail sets on a drag and the basis drop slot reads — a single key so the two agree.
 *  DISTINCT from the gate-chip MIME (ComposeContext.CHIP_DND_MIME) so a gate drag never lands here. */
export const AGENT_CHIP_DND_MIME = "application/x-piflow-agent-chip";

/** A dropped agent-reassign descriptor — POSTed to `/__piflow/node-edit` like a gate chip. TEMPLATE-ONLY
 *  by design (agentType is structural): the run-bake path rejects it. */
export interface AgentChip {
  kind: "agent";
  /** The base-agent preset id (the agents-catalog key) the node adopts. */
  agentType: string;
}

/** Build the drag payload for a rail row. The id is trimmed; caller guarantees non-emptiness (the rail
 *  only renders real catalog entries). */
export function buildAgentChip(agentType: string): AgentChip {
  return { kind: "agent", agentType: agentType.trim() };
}

/** Parse + validate a dropped drag payload → the AgentChip, or null on ANY garbage (never a partial
 *  object — the drop handler simply ignores a payload that isn't a well-formed agent chip). */
export function parseAgentChip(raw: string): AgentChip | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { kind, agentType } = parsed as { kind?: unknown; agentType?: unknown };
  if (kind !== "agent" || typeof agentType !== "string") return null;
  const id = agentType.trim();
  return id.length ? { kind: "agent", agentType: id } : null;
}

/** One AgentRail row: the stable preset id (the drag payload + face key), its display label/branding,
 *  and the hover eyebrow (the role prompt's first non-empty line, truncated to one line). */
export interface AgentRailEntry {
  id: string;
  label: string;
  icon?: string;
  color?: string;
  promptLine?: string;
}

/** The eyebrow cap — one line, comfortably inside the rail's expanded label width. */
const PROMPT_LINE_MAX = 96;

/** The role prompt's first non-empty line, truncated — the rail's one-line hover eyebrow. */
function promptLineOf(prompt?: string): string | undefined {
  if (!prompt) return undefined;
  const line = prompt.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  return line.length > PROMPT_LINE_MAX ? `${line.slice(0, PROMPT_LINE_MAX - 1)}…` : line;
}

/** Project the agents catalog → the rail rows, sorted by label. PURE — the rail renders this verbatim. */
export function agentRailEntries(catalog: AgentCatalog): AgentRailEntry[] {
  return Object.entries(catalog)
    .map(([id, d]) => {
      const promptLine = promptLineOf(d.prompt);
      return {
        id,
        label: d.label ?? id,
        ...(d.icon ? { icon: d.icon } : {}),
        ...(d.color ? { color: d.color } : {}),
        ...(promptLine ? { promptLine } : {}),
      };
    })
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id));
}

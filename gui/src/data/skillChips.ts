// skillChips.ts — the skill marketplace's PURE model: the draggable skill-card payload + the panel's
// search/ring projection. Product-agnostic, no React, no I/O — the twin of `agentChips.ts` (base-agent
// reassign) and `gates.ts` (gate compose). It pins the EXACT chip payload the write-back path
// (`gui/scripts/lib/node-writeback.mjs` → the node's `prompt.skill`) consumes.
import type { MarketSkill } from "./runView";

/** The MIME the market card sets on a drag and the on-node skill drop slot reads — one key so the two agree.
 *  DISTINCT from the agent-chip MIME (AGENT_CHIP_DND_MIME) and the gate-chip MIME so a cross-drag never lands. */
export const SKILL_CHIP_DND_MIME = "application/x-piflow-skill-chip";

/** A dropped skill descriptor — POSTed to `/__piflow/node-edit` like a gate/agent chip. Unlike an agent chip
 *  it is an OVERLAY (a `prompt.skill` loadout pointer, not a structural preset), so the run-bake ACCEPTS it. */
export interface SkillChip {
  kind: "skill";
  /** The skill id/ref the node adopts (the marketplace entry id). */
  skill: string;
}

/** Build the drag payload for a market card. The id is trimmed; caller guarantees non-emptiness (the panel
 *  only renders real catalog entries). */
export function buildSkillChip(skill: string): SkillChip {
  return { kind: "skill", skill: skill.trim() };
}

/** Parse + validate a dropped drag payload → the SkillChip, or null on ANY garbage (never a partial object —
 *  the drop handler simply ignores a payload that isn't a well-formed skill chip). */
export function parseSkillChip(raw: string): SkillChip | null {
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { kind, skill } = parsed as { kind?: unknown; skill?: unknown };
  if (kind !== "skill" || typeof skill !== "string") return null;
  const id = skill.trim();
  return id.length ? { kind: "skill", skill: id } : null;
}

/** The panel's search/filter projection: keep the entries matching `query` (case-insensitive substring over
 *  id + name + description) AND, when `ring` is given, only that ring. PURE — order is PRESERVED (a filter, no
 *  re-sort), so the panel renders the server's ordering verbatim. A blank/whitespace query narrows by ring only. */
export function marketFilter(entries: MarketSkill[], query: string, ring?: MarketSkill["ring"]): MarketSkill[] {
  const q = query.trim().toLowerCase();
  return entries.filter((e) => {
    if (ring && e.ring !== ring) return false;
    if (!q) return true;
    return `${e.id} ${e.name} ${e.description ?? ""}`.toLowerCase().includes(q);
  });
}

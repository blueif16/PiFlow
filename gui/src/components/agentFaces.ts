// agentFaces — the per-BASE-AGENT face art, keyed by the STABLE preset id (never the cosmetic
// `display.icon` key). ONE lookup shared by every surface that shows an agent identity — the node
// chip, the basis-mode card, the provenance chip, the hover card — so a node that adopts a base
// agent (`agentType`) INHERITS the same face everywhere, and the base agent itself is shown with
// it. A preset without a face falls back to its `display.icon` glyph (AgentAvatar) — never blocks.
// Source art: a 2×3 headshot grid split + background-extracted (see the assets' commit).
import author from "../assets/agents/author.png";
import coder from "../assets/agents/coder.png";
import explore from "../assets/agents/explore.png";
import plan from "../assets/agents/plan.png";
import reviewer from "../assets/agents/reviewer.png";
import synthesizer from "../assets/agents/synthesizer.png";

export const AGENT_FACES: Record<string, string> = { author, coder, explore, plan, reviewer, synthesizer };

/** The face for a base-agent preset id; undefined when the base has no face art (or no base). */
export const agentFace = (agentType?: string): string | undefined =>
  agentType ? AGENT_FACES[agentType] : undefined;

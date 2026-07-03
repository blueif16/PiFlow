/**
 * SkillContext — shares "which skill is open in the side panel" between the surfaces that render a skill
 * chip (the node card's AgentHoverCard, the NodeHud's agent-definition block) and the left SkillPanel that
 * shows the bundle. A skill chip calls `openSkill(id)`; the canvas renders the panel for that id. Kept in a
 * context (like ExpandContext) so no non-serializable callback is threaded through React Flow node `data`.
 */
import { createContext, useContext } from "react";

export interface SkillApi {
  /** the open skill id/ref, or null when the panel is closed */
  open: string | null;
  openSkill: (skill: string) => void;
  close: () => void;
}

export const SkillContext = createContext<SkillApi>({
  open: null,
  openSkill: () => {},
  close: () => {},
});

export const useSkill = () => useContext(SkillContext);

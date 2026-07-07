/**
 * IssuesContext — shares "which node TYPE's issue ledger is open in the side panel" between the surfaces
 * that render the affordance (the NodeHud identity row) and the right-dock IssuesPanel that shows the M8
 * ledger. A node calls `openIssues(nodeId)`; the canvas renders the panel for that node id. Kept in a
 * context (like SkillContext) so no non-serializable callback is threaded through React Flow node `data`.
 */
import { createContext, useContext } from "react";

export interface IssuesApi {
  /** the open node-TYPE id, or null when the panel is closed */
  open: string | null;
  openIssues: (nodeId: string) => void;
  close: () => void;
}

export const IssuesContext = createContext<IssuesApi>({
  open: null,
  openIssues: () => {},
  close: () => {},
});

export const useIssues = () => useContext(IssuesContext);

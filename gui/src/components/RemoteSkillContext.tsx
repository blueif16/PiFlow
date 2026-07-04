/**
 * RemoteSkillContext — the ONLINE twin of SkillContext. A LOCAL skill is inspected by id (SkillContext.open =
 * a string the server resolves on disk); a REMOTE search hit has no local id, so this context carries the whole
 * row (name/description/source/…) that the RemoteSkillPanel renders + best-effort-fetches the SKILL.md for.
 * It ALSO owns `installedNonce`: a successful one-click Install (from the card OR the detail panel) bumps it, and
 * SkillMarketPanel keys its marketplace re-fetch on it — so a freshly installed skill re-appears in the installed
 * ring as a bindable, draggable local card. A sibling context (like MarketContext/BasisContext), not a merge into
 * SkillContext, so the existing local skill-inspect path is untouched.
 */
import { createContext, useContext } from "react";
import type { RemoteSkill } from "../data/runView";

export interface RemoteSkillApi {
  /** the online row shown in the remote detail panel, or null when it's closed */
  open: RemoteSkill | null;
  openRemote: (row: RemoteSkill) => void;
  close: () => void;
  /** bumps on every successful install; SkillMarketPanel re-fetches the rings when it changes */
  installedNonce: number;
  bumpInstalled: () => void;
}

export const RemoteSkillContext = createContext<RemoteSkillApi>({
  open: null,
  openRemote: () => {},
  close: () => {},
  installedNonce: 0,
  bumpInstalled: () => {},
});

export const useRemoteSkill = () => useContext(RemoteSkillContext);

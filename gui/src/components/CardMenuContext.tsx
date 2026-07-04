import { createContext, useContext } from "react";

/**
 * CardMenuContext — while a right-dock card is open the floating MenuBar HIDES, and the open card hosts a
 * small MENU handle in its own top-right chrome (beside the close) so the bar never overlaps the card. This
 * context lets the shared SideCard render that handle without knowing anything about the MenuBar: the canvas
 * provides `onOpenMenu` (peek the full bar back over the card). Null ⇒ no handle.
 */
export const CardMenuContext = createContext<{ onOpenMenu: () => void } | null>(null);
export const useCardMenu = () => useContext(CardMenuContext);

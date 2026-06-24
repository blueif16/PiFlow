/**
 * ViewModeContext — shares the active "view mode" between the bottom-left ModeBar
 * (which sets it, by click or keyboard) and every WorkflowNode (which paints a
 * mode-specific strip beneath itself). Threaded via context, not React Flow node
 * `data`, so toggling a mode re-renders the nodes without rebuilding the graph
 * (same pattern as ExpandContext).
 *
 * One mode is active at a time, or none. The per-node info each mode reveals is
 * map-level decoration only — the expanded HUD already shows the same fields, so
 * we don't duplicate it there.
 */
import { createContext, useContext } from "react";

export type ViewMode = "status" | "model" | "artifacts";

export interface ViewModeApi {
  mode: ViewMode | null;
  /** select a mode, or pass null to clear */
  setMode: (m: ViewMode | null) => void;
  /** select `m`, or clear it if it's already active (the keypress / click toggle) */
  toggle: (m: ViewMode) => void;
}

export const ViewModeContext = createContext<ViewModeApi>({
  mode: null,
  setMode: () => {},
  toggle: () => {},
});

export const useViewMode = () => useContext(ViewModeContext);

/** The modes, in display order, with their key + human label. Single source for the
 *  ModeBar buttons AND the keyboard map, so the two can never drift apart. */
export const VIEW_MODES: ReadonlyArray<{ mode: ViewMode; key: string; label: string }> = [
  { mode: "status", key: "t", label: "Status" },
  { mode: "model", key: "m", label: "Model" },
  { mode: "artifacts", key: "a", label: "Artifacts" },
];

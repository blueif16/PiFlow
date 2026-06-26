/**
 * FusionContext — shares the per-node FUSION OVERRIDE between the WorkflowNode toggle (which sets it) and
 * the WorkflowCanvas (which fetches the re-expanded DAG when it changes). Threaded via context, not React
 * Flow `data`, so toggling re-fetches without rebuilding the graph wiring (same pattern as ViewModeContext).
 *
 * An override is `{ <nodeId>: "moa" | "best-of-n" }` — the canvas hands it to `/__piflow/preview`, where the
 * SDK's `withNodeFusion → expandFusion → compile` does the actual transform. The GUI NEVER rewrites the DAG
 * itself; it only declares WHICH node should be fused in WHICH mode and renders whatever the SDK returns.
 */
import { createContext, useContext } from "react";

export type FusionMode = "moa" | "best-of-n";

export interface FusionApi {
  /** node id → the mode it is currently fused as (absent ⇒ not fused). */
  overrides: Record<string, FusionMode>;
  /** set node→mode, or CLEAR it if it is already that mode (the click/keyboard toggle). */
  toggle: (nodeId: string, mode: FusionMode) => void;
}

export const FusionContext = createContext<FusionApi>({ overrides: {}, toggle: () => {} });

export const useFusion = () => useContext(FusionContext);

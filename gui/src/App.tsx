import { WorkflowCanvas } from "./components/WorkflowCanvas";
import "../tokens/tokens.css";

/**
 * App shell — full-bleed canvas, no chrome. Shared by BOTH entries: the live viewer (`src/main.tsx`,
 * what `piflowctl gui` serves — data comes from the real `/__piflow/*` Vite middleware) and the static
 * demo (`demo/main.tsx`, which additionally installs the bundled-data shim). The shell itself is pure
 * presentation — it holds NO data source, so it renders identically live or in the demo.
 *
 * Hover a node for the lift + HUD brackets; click (or Enter) to deploy its multi-panel HUD (the node
 * morphs into the identity panel, the rest fan in); Esc / click-scrim to close. The floating directory
 * navigator (top-left) drills folders Miller-style; opening a file leaf opens that node's HUD.
 *
 * Deep-link helper: /?open=<nodeId> opens that node's HUD on load.
 */
export function App() {
  const openId = new URLSearchParams(window.location.search).get("open") ?? undefined;
  return (
    <div style={{ height: "100%", background: "var(--ds-bg-canvas)" }}>
      <WorkflowCanvas initialExpandedId={openId} />
    </div>
  );
}

/**
 * NodeFusionToggle — the interactive control the Fusion view-mode paints under each node: two buttons
 * (MoA / best-of-N) that activate the SDK's fusion expansion for THIS node. Clicking sets the node's
 * override (canvas re-fetches `/__piflow/preview` → the DAG re-expands); clicking the active mode again
 * clears it (the node collapses back to the live run-view). `stopPropagation` keeps a button click from
 * also expanding the node's HUD.
 *
 * It is NOT rendered on a fusion-GENERATED producer (a `…-p<n>` sibling or `…-obl` obligations node, per
 * `expand.ts`'s naming) — those are outputs of the transform, not author nodes you toggle. The JUDGE keeps
 * the original node id, so its toggle still controls the same override (→ flip mode, or clear to collapse).
 */
import { useFusion, type FusionMode } from "./FusionContext";

/** fusion-generated producers (siblings / obligations) — `${label}__p${i}` / `${label}__obl` slugged. */
const GENERATED = /-(p\d+|obl)$/;

export function NodeFusionToggle({ nodeId }: { nodeId: string }) {
  const { overrides, toggle } = useFusion();
  if (GENERATED.test(nodeId)) return null;
  const active = overrides[nodeId];

  const Btn = ({ mode, label }: { mode: FusionMode; label: string }) => (
    <button
      type="button"
      className={`ds-fusiontoggle__btn${active === mode ? " is-active" : ""}`}
      aria-pressed={active === mode}
      title={`Fuse "${nodeId}" as ${label} — re-expands the DAG`}
      onClick={(e) => { e.stopPropagation(); toggle(nodeId, mode); }}
    >
      {label}
    </button>
  );

  return (
    <div className="ds-fusiontoggle" onClick={(e) => e.stopPropagation()}>
      <Btn mode="moa" label="MoA" />
      <Btn mode="best-of-n" label="best-of-N" />
    </div>
  );
}

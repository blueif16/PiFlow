# Demo data (static flowmap demo)

Bundled JSON that powers the pure-frontend demo built by `npm run build:demo` and served
from the marketing site at `/gui-demo/`. At runtime there is NO server — `demo/demoFetch.ts`
answers the GUI's `/__piflow/*` calls from these files (inlined into the build via
`import.meta.glob({ eager: true })`), so the demo makes zero network calls to `/__piflow/*`.

## Contents
- `index.json` — the trimmed global index (the featured runs). The LAST thread is the default
  run `pickCurrentRun` opens, since none are `running` and `updatedAt` is null.
- `run-view/<id>.json` — the distilled run-view the canvas/HUD render (one per featured run).
- `tree/<id>.json` — the run's on-disk file tree for the "Run files" navigator.
- `agents.json` — the agent-preset catalog (node icons). Managed separately (not regenerated
  by `data:demo`).

Featured runs are deliberately LIGHT, on-brand example runs (not the heavy game-omni run): the
demo is a "what a real run looks like" showcase, not a stress test. Current set:
`academy-e2b-final` (example-academy, 2 nodes research→build — the default) and `demo-fusion`
(example-fusion, 10-node MoA + best-of-n DAG — selectable from the switcher).

## Refresh / re-curate (one command)
The featured runs are a HAND-PICKED list at the top of `gui/scripts/build-demo-data.mjs`
(`FEATURED`). Each must be a real, distillable run under `<repo>/.piflow/<namespace>/runs/<run>`
(more example runs land there over time; pick the ones to show). The script distills each the
EXACT way the live dev middleware does (`buildSnapshot` for the index rows + `buildRunView` for
the view + the same fs walk for the tree), so the demo never drifts from the real product.

1. Edit `FEATURED` in `gui/scripts/build-demo-data.mjs` (order matters — the LAST entry is the
   run the GUI opens on first load).
2. `cd gui && npm run data:demo` — rewrites `index.json` + `run-view/**` + `tree/**` here.
3. `npm run build:demo` — writes `site-piflow/public/gui-demo/` (the iframe picks it up).

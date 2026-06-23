# @piflow/tui — the run monitor (`piflow-tui`)

The pi-flow terminal monitor: render ONE run's DAG + per-node inspector, live, in your terminal.

```bash
piflow-tui <rundir>            # the run dir holding .pi/run.json (e.g. .piflow/<wf>/runs/<id>)
piflow-tui <rundir> --every 5  # refresh interval in seconds (default 2)
```

```
NAMESPACE           THREAD                       DETAIL
the run dir      →  the run                  →   the run's DAG, per-node + a node
(● running)         (status · progress)          INSPECTOR: description · data-flow ·
                                                  input/output files · live output tail
```

The DETAIL pane has **two views, toggled with `v`**: the default **list** (per-node rows with a
sub-cell Gantt timeline) and a structural **graph** — the run drawn as a left→right layered DAG, one
column per stage, with box-drawing edges routed from the real file data-flow and live status colour on
each node. Keys: `↑↓` select · `←→` / `Tab` move pane · `⏎` drill in (node → its files; file → an
in-terminal overlay viewer) · `v` list ⇄ graph · `l` per-edge file labels (graph) · `e` export a
Mermaid `.mmd` snapshot beside the run dir · `q` quit.

## Migrated from the legacy pi-runner TUI

This is the legacy ink monitor (`templates/legacy/tui/`) with **only its data-acquisition layer
re-pointed** to the new `.pi/` run layout. The DAG/per-node rendering and the overall visual are
IDENTICAL — `dag.mjs` is verbatim, `components.mjs` changed only its data imports + read sites.

| What | Legacy source (`out/<id>`) | New source (the `.pi/` layout, via `@piflow/core` helpers) |
|---|---|---|
| per-node status / timing | the run-status digest | `<rundir>/.pi/run.json` (`runJsonFile`) |
| live event tail | the per-node debug event archive | `<rundir>/.pi/nodes/<id>/events.jsonl` (`nodeEventsFile`) |
| io + data-flow edges | parsed from prompt text | `<rundir>/.pi/nodes/<id>/io.json` (`nodeIoFile`; `NodeIo.reads`/`writes`) |
| project list | the global registry + a static-DAG re-extract | GONE — a run dir is self-describing; one dir = one run |

`.pi/run.json` IS a `RunStatus` (`packages/core/src/runner/status.ts`), so the status→row mapping
ports verbatim; the **data-flow edges** are now read from the structured io ledgers — a write of node A
that another node B reads back is the edge A→B (the engine's only hard guarantee: nodes coordinate
through files) — instead of matching prompt text. All paths come from `@piflow/core`'s layout helpers;
**no path is hardcoded** and `@piflow/core` is never modified.

## Files

- `pi-tui.mjs` — the `piflow-tui <rundir>` entry (renders the monitor).
- `model.mjs` — the renderer-agnostic **data layer** (the migrated read functions: `buildModel`,
  `tailNodeOutput`, `summarizeRun`, `discoverNamespaces`). **This is the only file the migration
  rewrote.**
- `components.mjs` — the ink view layer (data imports re-pointed to `./model.mjs`; visuals unchanged).
- `dag.mjs` — the structural DAG renderer (verbatim from the legacy; pure presentation).
- `test/render.test.mjs` + `test/fixtures/` — a fixture `.pi/` run dir (written with core's layout
  helpers) and the headless render smoke test (`ink-testing-library`).

## ink dependency (offline)

ink + react + htm (the legacy stack) and `ink-testing-library` (dev) are declared in `package.json`
and installed via the workspace: run `npm install` **from the repo root** (the workspace hoists ink
into the root `node_modules`). Do NOT `npm install` inside this package — that detaches it from the
workspace and drops the root dev deps (vitest). `@piflow/core` resolves as a workspace symlink; build
it once with `tsc -b packages/core` so its `dist/` (the import target) exists.

## Field notes (legacy fields the `.pi/` layout does not carry)

The migrated reader renders the fields the `.pi/` layout provides and degrades gracefully on the rest
(the visuals already guarded every optional field with `|| null`). Fields the legacy could show that
the current `.pi/` layout does not surface, so they read as empty/zero rather than fabricated:

- **token / cost rollup** (`tokens`, `tokensBillable`, `cost`) — `NodeStatusRecord` carries no token
  accounting today, so the header `tok` and per-node token columns show `0`.
- **per-node skill + prose description** — the legacy parsed these from the recorded prompt; the io
  ledger carries `phase` (used as the description) but no `skill` line.
- **tool breakdown / thinking chars / live heartbeat** (`toolBreakdown`, `thinking`, `live`) — not in
  the status record; the inspector omits them.
- **the static DAG / phases metadata** — there is no separate workflow re-extract; stages are
  reconstructed from the run status (in-file node order + the live parallel barrier).

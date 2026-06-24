# pi-runner TUI monitor — `pi-tui`

One global command. Type **`pi-tui`** and see every project you've run, with its live runs:

```
NAMESPACES          THREADS                      DETAIL
one per project  →  that project's runs      →   the run's DAG, per-node + a node
(● running)         (status · name ·             INSPECTOR: description · skill ·
                     overall progress)           data-flow · input/output files
```

The DETAIL pane has **two views, toggled with `v`**: the default **list** (per-node rows with a
sub-cell Gantt timeline) and a structural **graph** — the run drawn as a left→right layered DAG,
one column per stage, with box-drawing edges routed from the real file data-flow and live status
colour on each node. Both share the same selection, so `v` just changes how the same run is drawn.
In graph mode you navigate in **2-D** (`↑↓` within a stage, `←→` across stages), press **`l`** to
label every edge with the file that flows along it, and **`e`** to export the run as a portable
Mermaid snapshot (`out/<id>/graph.mmd` — render it with mmdc, mermaid.live, or any Markdown
preview). `e` works from either view.

Select a node and the **inspector** below shows what it is (its description + skill), how it wires
into the chain (a tiny `upstream ─▶ [node] ─▶ downstream` data-flow), and its **exact input and
output files** with each file's functionality and where it comes from / goes to. Step into the files
(`⏎`) and view the real file in a scrollable **in-terminal overlay** (`⏎` again; `esc` closes) —
no jumping to another app. Binaries (images, etc.) show their size with `o` to open externally.

No flags. No config. You never register a project by hand — **`run.mjs` registers it for you**
on every run (idempotent upsert into `~/.pi-runner/registry.json`), so anything you've ever run
with pi-runner shows up automatically.

## Install once

```bash
cd pi-runner/tui
npm install
npm link          # puts `pi-tui` on your PATH (or: npm i -g .)
```

Now, from anywhere: `pi-tui`.

## Commands

```
pi-tui                      every registered project + its live runs (the default)
pi-tui ls                   print the registry
pi-tui add [dir] [--name X] register a project you haven't run yet (defaults to cwd)
pi-tui rm  [dir]            forget a project
```

Advanced — these compose with the registry:
`--scan <parent>` (each child with an `out/` becomes a namespace) · `--root [name=]dir` ·
`--out <name>` · `--every <s>` (refresh, default 2) · `--no-registry`.

## Keys

`↑↓` select in the focused pane · `←→` / `Tab` move pane · `⏎` drill in (on a node → its files; on a
file → view it in an in-terminal overlay) · `v` toggle DETAIL list ⇄ graph · `q` quit

In the **graph** view: `↑↓` move within a stage · `←→` move across stages · `l` toggle per-edge file
labels · `e` export the run to `out/<id>/graph.mmd` (Mermaid).

In the file overlay: `↑↓` scroll · `space`/`PgDn` page · `g`/`G` top/bottom · `o` open a binary
externally · `esc` close.

## How it works (nothing duplicated)

Reads what pi-runner already writes: the static DAG from each project's workflow `.js`
(`extract.mjs`, no model cost) joined to `out/<id>/run-status.json` on the node `id`. Stages,
Gantt, time-spent and pathways are all *reconstructed*. The inspector is too: the per-node
**description** comes from the workflow's `meta.phases`, the **input/output files** from each node's
`contract()` markers (`DRIVER-ARTIFACTS`/`DRIVER-READ-SCOPE`), and the **data flow** by the engine's
own rule — an output of node A that appears in node B's prompt is a file B reads from A. Nothing new
is persisted. The renderer-agnostic data layer is `../viz-model.mjs`; the Ink view is
`components.mjs`; the structural graph renderer (`v`) is `dag.mjs` — it reads the same
`buildModel()` output (stages = layers, `node.lane` = row, `io.outputs[].toNodes` = edges) and draws
box-drawing connectors composited by stroke bitmask; this dir's `pi-tui.mjs` is just the entry.

## Notes

- **Run it where the runs live.** A *namespace* is a project root; *threads* are its runs.
  Run `pi-tui` on the machine/VM that holds the runs and the artifact file-info (path · exists ·
  size) and live-output tail reflect that filesystem directly — no extra plumbing.
- **Live output** (the tail under a node) comes from `_pi/<node>.events.jsonl`, which pi-runner
  writes only under `--debug`. Without it you still see the streamed char-count + current tool.
- **Opt out of auto-register** per run with `PI_RUNNER_NO_REGISTER=1`; relocate the registry with
  `PI_RUNNER_REGISTRY=<path>`.
- Stale entries (a project whose `out/` was deleted) are auto-skipped; `pi-tui rm` removes them.

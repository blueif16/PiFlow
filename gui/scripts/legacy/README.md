# legacy — retired Path A (offline transcode → static run-view.json)

These four files are **archived, not maintained**. They were the GUI-local data layer before the run-view
distiller was consolidated into the shared package `@piflow/core/observe`.

| file | what it was | superseded by |
|------|-------------|---------------|
| `distill.mjs` | the rich per-node event-stream reducer | `packages/core/src/observe/distill.ts` (`createNodeAccumulator`) |
| `build-run-view.mjs` | distilled `gui/public/runs/<run>/.pi` → a static `run-view.json` | `packages/core/src/observe/runView.ts` (`buildRunView`) + the live `/__piflow/run-view/<run>` Vite endpoint |
| `transcode-run.mjs` | copied a real run's `.pi` into `gui/public/runs/<run>` | not needed — the endpoint distills any run's real `.pi` in place |
| `distill.test.mjs` | unit test for the GUI-local reducer | **to port** → `packages/core/test` (test the core reducer, don't resurrect this) |

**Why retired:** data collection must live in the shared package (one stream for GUI + TUI + CLI), never in
a view. The canvas now loads EVERY run through the on-demand endpoint — no transcode step, no static
`run-view.json`, nothing copied into the repo. See `docs/research/` + the `observe-single-data-path` memo.

Kept for reference/history only. The relative paths were patched for the new depth; do not wire them back
into the build.

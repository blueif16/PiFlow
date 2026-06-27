# piflow — Project Conventions

## Data & SDK boundaries
NEVER store product-specific info, collected data, snapshots, or a global index inside the SDK
(`packages/*`, esp. `@piflow/core`). The SDK is logic only and must stay product-agnostic.
- **Per-product / per-repo data** (templates, runs, `run-view.json`) lives IN that product/repo.
- **Global mapping · index · snapshots** live in the home global dir `~/.piflow/`
  (`products.json` = registered repos; `index.json` = the unified snapshot). Generators WRITE
  there, never into the repo. Parallels the pi runtime's `~/.pi/`.
- The GUI is a static viewer: NEVER commit collected data into it (no `gui/public/index.json`);
  read the global index from `~/.piflow/` via a dev mechanism (e.g. a Vite middleware).
- Reuse shared shapes (e.g. `summarizeRun` from `tui/model.mjs`) so TUI + GUI agree.

## Releasing (npm)
The `@piflow/*` packages are PUBLISHED to npm (public scope `@piflow`; `@piflow/tui` + the root stay
`private`). Full runbook: `docs/RELEASING.md` — follow it, never improvise a publish.
- **Default to MAINTAIN, not RELEASE.** Published versions are immutable; the record of progress is git,
  NEVER an `npm publish`. For each consumer-facing change run `npm run changeset` (it accumulates).
- **Publish ONLY from `main`, clean tree, gate green:** `npm run version-packages` → the `docs/RELEASING.md`
  pre-release checklist → `npm run release`. NEVER publish from a feature branch or to "save progress."
- **The CLI bin is `piflowctl`**, not `piflow` (collision with the unrelated `@arche-sh/piflow`); never
  register the unscoped `piflow` name. Don't hand-edit versions/internal ranges — Changesets owns them.

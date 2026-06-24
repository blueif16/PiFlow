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
- Reuse shared shapes (e.g. `summarizeRun` from `packages/tui/model.mjs`) so TUI + GUI agree.

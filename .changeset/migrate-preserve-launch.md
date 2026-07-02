---
"@piflow/cli": patch
"@piflow/server": patch
---

Preserve a migrated run's launch config. When a frozen run is migrated to another host and resumed, the
resume previously dropped `--provider`/`--model`, so the migrated tail fell back to the runner's default
provider (a run started on `mmgw` resumed on `cp`). The resume now recovers the source run's provider + model
from its persisted `RunModel` (`.pi/run.json`) and threads them into both the CLI download resume and the
server-side adopt. (`--thinking` and per-node `--executor` are not persisted at run start and remain a
follow-up.)

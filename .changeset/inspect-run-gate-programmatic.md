---
"@piflow/cli": patch
---

`piflowctl inspect` no longer gives two false "not wired" signals.

- The `ops:` line now covers ALL THREE op families — run-family ops and gate ops (pre/post), not just derive
  transforms. A node migrated to `op:[{run}]` (or carrying a gate) used to render `ops: (none)` even though
  the runner dispatches it.
- A `programmatic` node (which spawns no pi and therefore has no prompt / no `DRIVER-*` markers) now prints
  its resolved `op[]` directly instead of an empty `prompt:` block that read as "0 markers → not wired".

---
"@piflow/core": patch
---

Fix runs showing "running" forever after their controller process died (crash, `kill -9`, closed terminal,
or a `piflowctl node --stop`). `readRunModel` now verifies a claimed-`!done` run against its recorded
`controllerPid`: when the process is confirmed dead (and the run isn't a deliberately-parked P6 migration
freeze), the run is treated as terminal — `done:true`, `ok:false`, and a new `RunModel.orphaned`/
`ThreadRow.orphaned` flag lets a viewer label it distinctly from a genuine reported failure. This is the
single shared reader every consumer (CLI, TUI, the GUI fleet snapshot, and the live SSE stream) already
calls, so the fix applies uniformly with no new endpoint or background process.

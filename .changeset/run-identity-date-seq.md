---
"@piflow/core": minor
"@piflow/cli": minor
---

Run identity now scales to hundreds of agent-minted runs a day.

`piflowctl run <templateDir>` (omitted `--run/--id`) now mints a scannable `YYMMDD-NN` date-sequence
name (e.g. `260706-01`, the Nth run today) instead of the prior random Docker-style
`<adjective>-<pie>` pick — still collision-checked against the existing run dirs. The pie-name
generator (`generateRunName`) stays exported for a caller that wants it; its word-space is reassigned
to issue naming in the upcoming optimize-substrate work.

- `@piflow/core` exports the new default generator `generateDateSeqName(existing, now?)` plus
  `childRunName(parentId, nodeId, existing?)` — the `<parent>.<nodeId>` naming convention for a
  spawned CHILD run (a replay of one node from a finished parent run).
- `RunStatus` gains optional lineage fields — `parent` (the originating run's id) and `spawnedBy`
  (`{by, issue?, issueId?}`) — threaded through `RunOptions`/`runWorkflow` and recorded into
  `run.json`; both are absent on a normal top-level run.
- New `spawnChildRun(parentRunDir, nodeId, opts)` (core-internal, `optimize/substrate/child-run.ts`):
  replays exactly one node of a finished run into a fresh sibling run-dir — resetting that node's own
  resolved write scope and warm session so it re-executes cleanly, while everything upstream is
  reused untouched. This is the replay primitive the upcoming per-node optimize substrate's fix-and-
  verify loop proves a candidate edit against.

---
"@piflow/core": patch
---

Fix `telemetryStream` (the agent-facing anomaly stream) to select its per-node accumulator by
the node's driver, like the `observe`/SSE path already does.

The live anomaly stream drives its OWN per-node accumulator, and it was hardcoded to the pi
reducer (`createNodeAccumulator`). The pi reducer no-ops on Claude `--output-format stream-json`
vocabulary (`assistant`/`user`/`system`/`result` fall through `distill.ts`'s `default: break`), so
a **claude-code** node's live telemetry read hard-zero: no tokens, no tool calls, and no
`tool-loop`/loop-score signal — the very anomalies a supervising agent watches for.

`telemetryStream` now selects the reducer via the SAME machinery `buildRunView` (replayEvents) and
`watchRun` (seedNode) use — `builtinDrivers()` → `get(executor)` for a stamped node, else
`DriverTable.detectUnstamped` over the node's retained event log. The stamped executor arrives on
the snapshot node (started-before-attach) or a `node-enriched` delta (started-after); a node that
starts mid-stream begins provisional-pi through its unsniffable leading `system` lines and FLIPS to
the count-only Claude decoder the moment an `assistant` line appears, replaying its retained log so
no folded history is lost. pi nodes are byte-identical to before.

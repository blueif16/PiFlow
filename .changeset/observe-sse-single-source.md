---
"@piflow/core": minor
---

Fold per-node telemetry incrementally in the live observe stream — the single enriched live source.

`watchRun` now folds each node's telemetry **incrementally server-side** (over the byte-offset tail it
already maintains, via a non-destructive accumulator snapshot) and emits `node-enriched` deltas carrying
the full re-assembled `RunViewNode` — the same `assembleNode`/`nodeTokenSpine`/`deriveNode` the batch
`buildRunView` uses, so the live graph and the loaded run-view render byte-identical per-node data. To
carry it, `NodeView`/`RunModel` are widened with optional `tokens`/`derived`/`tokenTotal`, and `RunUpdate`
gains a new `node-enriched` kind (registered in the CLI stream allowlist). Additive: every new field is
optional and the new kind is a superset read, so existing consumers are unaffected.

To make the live fold byte-identical to `/run-view` (the P4 parity cutover), the enriched node now also
carries per-node `provider` (`NodeView.provider`), and `watchRun` accepts the SAME cross-run + workspace
context `buildRunView` does: `WatchOpts` gains optional `historyDirs`/`workspaceRoot` (so `derived.time`
and reads/writes/edge display paths match the loaded view), `readRunModel` accepts an optional
`{ workspaceRoot }`, and `makeDisplayPath`/`buildHistory` are now exported from `@piflow/core/observe` (the
shared context builders both readers reuse). All additive — omitting the new options preserves today's behavior.

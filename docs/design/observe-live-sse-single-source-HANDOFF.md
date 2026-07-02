# Hand-off — observe live SSE single source (P4-live DONE · P5 next)

## Snapshot (verified state, branch `feat/observe-live-sse-source`, NOT merged)
Design contract: `docs/design/observe-live-sse-single-source.md`. Built + verified (full gate green at each; every phase adversarially mutation-probed):
- `5bd120e` P0a — nodeTokenSpine + assembleNode + non-destructive `acc.snapshot()`
- `3881e46` P0b — resolveStructure (readRunModel ≡ buildRunView on edges/stages)
- `bd9803e` P1 — widened wire (optional tokens/derived/tokenTotal, `node-enriched` kind, CLI allowlist)
- `9f75bb8` P2 — watchRun folds incrementally + node-enriched deltas (the server single source; mirror-tested vs buildRunView over pi+Claude+reused+awaiting-input)
- `8f1cd7e` P3 — GUI renders from `live.model` behind the `liveSource` flag
- `f19b3c4` P4a — shadow-diff parity harness (dev-only, `?shadow=1`)
- `67beeb0` — liveModelToRunView carries the SSE stages
- **`f8e9865` P4-fix — the live SSE fold byte-matches /run-view (4 divergences fixed, below)**
- **`5479a4c` P4-test — headless SSE≡/run-view parity gate (`gui/src/data/sseParity.test.ts`)**
- **`abebb82` P4-flip — the live default is now `sse`**

## P4-live — DONE (parity proven, default flipped)
Rather than a manual `?live=sse&shadow=1` browser eyeball, parity is now a **deterministic, CI-safe test** that
drives the SAME code the browser does: REAL `watchRun` → REAL `reduce` → REAL `liveModelToRunView`,
shadow-diffed vs REAL `buildRunView` (frames JSON-round-tripped on BOTH sides — the wire is JSON both ways).
Covered: settled snapshot, a **parallel** fan-out stage, the **incremental node-enriched delta** path, and a
history-context REPRO (teeth). An env-gated case (`PIFLOW_PARITY_RUN`) ran the same proof against **real** runs
`gs01`/`p06`/`run01`/`gs02` — all clean.

Four real divergences the P4a fixtures never exercised were found and fixed in `f8e9865` (all "the live fold
must equal /run-view"):
1. **per-node `provider`** — the adapter blanketed the run provider; `buildRunView` detects it per-node (null
   for a rec.usage node). Now carried on the wire (`NodeView.provider` + `mergeEnriched`) and rendered as `n.provider`.
2. **`durationMs`** — the adapter dropped it. Now carried.
3. **`derived.time`** — `watchRun` folded with NO history (ratio 1, tone `ok`) while the /run-view handler passes
   `historyDirs` (mean of siblings → a different tone). `watchRun` now threads `historyDirs` (reusing `buildHistory`).
4. **reads/writes/edge display paths** — `watchRun` used a run-only `displayPath`; /run-view uses `workspaceRoot`
   too. `watchRun`/`readRunModel` now thread `workspaceRoot` (reusing `makeDisplayPath`); the **SSE handler**
   resolves + passes the SAME history+workspace the run-view handler does.

Default flipped `poll` → `sse` (`liveSource.ts`). Escape hatch intact: `?live=poll` (runtime),
`VITE_PIFLOW_LIVE_SOURCE=poll` (build), + the automatic degrade-to-poll on SSE failure/done in `WorkflowCanvas`.

## Remaining

### P5 — demote the 3 s replay loops (now that `sse` is default)
- `WorkflowCanvas.tsx`: the 3 s `/run-view` re-poll is already SKIPPED under `sseLive`; with `sse` default the
  live path no longer re-polls. VERIFY in the network tab (no 3 s `/run-view` during a live sse run).
- `RunDigestPanel.tsx`: still self-polls `/run-digest` every 3 s off `live.status`. Drive its refetch off
  `node-status`/`done` deltas (event-driven, like DR5's file-tree refresh) or an explicit slower cadence. Keep
  `/run-view` + `/run-digest` for one-shot loads.
- Optional (DR6 reconcile net): a `visibilitychange` + slow (≥30 s) `/run-view` reconcile, applied as MODEL
  REPLACE (not field-merge).

### Thrust 3 (separate, design §9)
- The AgentDriver registry: `nodeTokenSpine`/`assembleNode` (P0a) is its seam (formalize the rec.usage-vs-replay
  branch into named per-agent-type drivers). Cross-run derivable metrics (extend `buildHistory`/`derive`).

## Verification bar (every step)
`npx tsc -b` · `npx tsc --noEmit` in `gui/` · `npm --prefix gui run build` · `npm test` — all green.
Current: **1624 pass / 8 skip** (the 8th skip = the env-gated real-run parity case).

## Gotchas (do NOT regress)
- The SSE stream MUST be fed the SAME `historyDirs` + `workspaceRoot` the /run-view handler passes to
  `buildRunView` (else `derived.time` + display paths diverge). The two handlers now resolve them identically.
- The running-node ELAPSED clock stays view-side (`NodeModeStrip` `Date.now()`); `deriveNode.time` is null for
  running nodes; the node-enriched fold-signature EXCLUDES clock/updatedAt.
- `node-enriched` MUST stay in `packages/cli/src/remote.ts` `RUN_UPDATE_KINDS`.
- `watchRun` uses NON-destructive `acc.snapshot()`, never `finalize()`, on a live accumulator; seed replays
  `[0,size)` via the same `tailEvents` primitive (byte-aligned).
- The GUI mirrors core shapes LOCALLY (no `@piflow/core` import in the browser BUNDLE). The parity TEST imports
  core src by relative path — that's a test, not the bundle.

## Before merge
- `@piflow/core` changeset updated (`.changeset/observe-sse-single-source.md` now covers the P4 additive surface:
  `NodeView.provider`, `WatchOpts.historyDirs/workspaceRoot`, `readRunModel({workspaceRoot})`, exported
  `makeDisplayPath`/`buildHistory`). P4-live is clean → ready to merge `feat/observe-live-sse-source` → `main`
  with `--no-ff`. P5 can land before or after the merge.

# Compose / gate-drag — behavior audit (2026-07-02)

Read-only audit of the Compose view-mode (`c`): the ChipPalette → drag → NodeGateChips drop → template
write-back path. Input to the compose UX redesign. Claims are file:line-verified in worktree
`gui-frontend-fixes`; the two load-bearing findings (4.1, 4.2) were independently re-verified by the
main session. One correction vs. the original agent report: the pure write-back lib lives at
`gui/scripts/lib/node-writeback.mjs` (handlers.ts loads it dynamically via `findLib`, handlers.ts:428-435).

## 1. Entry & UI inventory

Compose is one of six view-modes (`ViewModeContext.tsx:44`, key `c`), toggled from the bottom-left
ModeBar (click or hotkey, `ModeBar.tsx:25-56`). When active:
1. `<ChipPalette>` mounts (`WorkflowCanvas.tsx:503`) — a body-portaled glass bar one row above the
   ModeBar (`modes.css:325-340`, z `--ds-z-popover` 1200).
2. Each node swaps its mode strip for the drop target `<NodeGateChips>` (`WorkflowNode.tsx:302-305`).
3. The always-on gate glyph row `NodeGates` is HIDDEN (`WorkflowNode.tsx:296`).
4. The canvas fetches each node's authored template config via `/node-config` (`WorkflowCanvas.tsx:385-398`).

Palette contents are a hardcoded array (`ChipPalette.tsx:27-34`), text-only chips, no glyphs:
- Gates: `execution` · `judge` · `human` (draggable buttons, payload = canned defaults).
- Loadout: `skill` · `loadout` — greyed, NOT draggable, pure stubs (`ChipPalette.tsx:60-64`).

Drop target: `.ds-gatechips` dashed border → solid accent on drag-over (`modes.css:300-304`); after a
drop, a 2.2 s flash `+<kind>` (green) or a red error truncated to 28 chars (`NodeGateChips.tsx:33-35,67`).
No save button, no preview — writes fire immediately on drop (contrast Fusion's explicit `FusionSaveBar`).

## 2. Interaction trace per chip kind

Shared spine: dragstart sets `CHIP_DND_MIME` payload (`ChipPalette.tsx:50-53`) → drop → `dropChip`
(`WorkflowCanvas.tsx:403-412`, target hardcoded `"template"`) → `dropChipOnNode` POST
`/__piflow/node-edit/<run>` (`runView.ts:263-281`) → server `piflowNodeWriteback` (`handlers.ts:456-508`)
→ `writeNodeEdit` (`gui/scripts/lib/node-writeback.mjs:172-199`): read `<template>/nodes/<id>/node.json`,
`chipToOps`, validate vs core `nodeSchema`, atomic write.

| Chip | What happens | Classification |
|---|---|---|
| execution | appends `op { when:"post", run:{cmd:"npm test"}, onFailure:"block" }` to template node.json | PERSISTED-TO-TEMPLATE |
| judge | payload omits `rubric` (`ChipPalette.tsx:29`); `chipToOps` hard-requires it (`node-writeback.mjs:88`) → 400, nothing written, red truncated flash | NO-OP — always fails |
| human | sets `node.checkpoint {kind:"confirm", prompt}` (G5 CheckpointSpec) | PERSISTED-TO-TEMPLATE |
| skill / loadout | inert spans, no drag possible | NO-OP stubs |
| floor (code-only) | full write path exists (`node-writeback.mjs:72-79`) but absent from the palette | UNREACHABLE from UI |

The server's `target:"run"` branch is a 501 stub (`handlers.ts:489-491`); the GUI never sends it —
every successful write is durable-to-template.

## 3. Template semantics

- execution → post-node deterministic command gate in `op[]`; exit code is the verdict; post-gate
  outcomes feed `io.checks` (two-layer).
- judge → producer-side `on-failure rerouteTo(self, max)` op + `node.judgeGate {judgeTier, rubric,
  threshold?, policy:{retryMax}}`; the loader's `materializeJudgeNodes` (loader.ts:264-271) inserts a
  real `<id>__judge` node AT NEXT TEMPLATE LOAD — never into the currently rendered run.
- human → `node.checkpoint` (CheckpointSpec), not an op[] entry.
- floor → post `gate:{kind,path?,advisory?}` structural Check predicate; core-complete, no chip.

## 4. Gap list (root causes of "I drag but nothing happens")

1. **Judge chip can never succeed** — palette default omits the required `rubric` → guaranteed 400 +
   28-char red flash. The single biggest confusion source.
2. **Successful drops barely change anything visible** — the write lands in the TEMPLATE, but the
   canvas renders the RUN's distilled `.pi/`. Only signals: a small text chip in the compose badge +
   a 2.2 s flash. Node/edge geometry untouched.
3. **Judge's structural effect is invisible** — `<id>__judge` node only materializes when a NEW run
   compiles the template.
4. **Two gate representations disagree** — observe row `NodeGates` (run-view `config.gates`) is hidden
   in compose; compose badge reads template `op[]` via `/node-config`; never shown side by side.
5. **No durability signal / no explicit save** — nothing says "written to template/nodes/<id>/node.json;
   affects FUTURE runs, not this one."
6. **Drops on non-author nodes fail cryptically** — `templateDirFor`/`readNodeConfig` 404 → truncated
   flash (`handlers.ts:451`, `node-writeback.mjs:149`).
7. **No parameter editing** — every drop is a canned default (`ChipPalette.tsx:26-31` comment defers
   the inline form).
8. **Loadout section advertises non-existent capability** (stubs).
9. **`floor` gate implemented but undiscoverable** (no chip).
10. **Static/demo build silently no-ops ALL edits** — `demoFetch.ts:101-110` returns inert `{ok:true}`
    with no `node` → green flash, badge never updates.

## 5. Redesign assets

- Glass chrome: `GlassSurface variant="soft" legibleText`; floating-chrome idiom = body portal +
  `pointer-events:none` layer (`modes.css:325-340`; the a941c34 convention).
- Z-tiers (`tokens.css:204-215`): rail 800 < scrim 900 < overlay 1000 < modal 1100 < popover 1200 <
  toast 1300. `--ds-z-toast` is defined but NO toast primitive exists yet.
- Gate policy-tone vocabulary (`gates.css:22-27`, `NodeGates.tsx:19-32`) + per-kind glyph SVG set
  (`NodeGates.tsx:41-92`) — palette/badge currently ignore both; unifying them is the obvious move.
- Feedback primitives to build on: the inline flash (`NodeGateChips.tsx:67`) and the FusionSaveBar
  status-bar pattern (`modes.css:237-282`).

## 6. Unverified

Static-read only (no live drag performed). Which build the user saw (live console vs demo shim) is
undeterminable from code — gap 10 alone explains the complaint if it was the demo. The
`materializeJudgeNodes` graph rewrite and `retryScope` path were not traced end-to-end.

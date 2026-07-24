---
type: subsystem
key: run-profiles
title: Run profiles (--profile — the additive gate overlay + the deprecated node-elision model)
description: How `--profile <name>` modulates a run WITHOUT editing the template. The slot carries TWO models — the LIVE additive overlay (a sparse per-file JSON that APPENDS GateEntry[] to named nodes, loadProfileOverlay + mergeProfileOverlay) and the DEPRECATED-but-reachable elision model (resolveProfile/applyProfile drop phase-matched nodes + transitively rewire deps), with a documented resolution precedence and a loud deprecation warn.
resource: packages/core/src/workflow/profile-overlay.ts
aliases: [profile, --profile, run profile, profile overlay, additive overlay, ProfileOverlay, loadProfileOverlay, mergeProfileOverlay, elidePhases, node elision, resolveProfile, applyProfile, applyProfileByName, defaultProfile, ProfileSpec, transitive dep rewire]
seeds: [packages/core/src/workflow/profile-overlay.ts, packages/core/src/workflow/profile.ts, packages/core/src/workflow/template/schema/profile.schema.ts]
symbols: [loadProfileOverlay, mergeProfileOverlay, ProfileOverlay, ProfileOverlayError, resolveProfile, applyProfile, applyProfileByName, UnknownProfileError, profileSchema]
tags: [profiles, overlay, elision, loader, gates, core]
timestamp: 2026-07-07
---

# Why / how it works (the lifecycle, end to end)
`--profile <name>` modulates a run WITHOUT editing the template, and the slot carries TWO models. The LIVE model is
the ADDITIVE overlay: a sparse per-file JSON at `template/profiles/<name>.json` (validated fail-closed against
`profileSchema`, `additionalProperties:false`), shaped `{ description?, nodes: {<id>: GateEntry[]} }`.
`loadProfileOverlay(dir, name, validate)` reads + validates it and returns `null` when the file is ABSENT (so the
caller falls through to the legacy path / a loud unknown-profile error); `mergeProfileOverlay(loaded, overlay)`
APPENDS each `nodes[<id>]` list to that node's `gates[]` IN PLACE (authored-first, overlay-second) — an overlay can
only ADD gates, never elide or toggle; a `nodes` key that is not a declared node id is a loud `ProfileOverlayError`
listing the known ids (a typo must not silently gate nothing). The loader wires this when `opts.profile` is set,
BEFORE the per-node fan-out ([[gate-composition]]), so a profile-added `agentic` gate materializes its judge on the
SAME path an authored one does. The DEPRECATED-but-still-reachable model is ELISION: `resolveProfile` picks the
active `ProfileSpec` off the spec's declared `profiles` (`--profile` name → declared → `defaultProfile` → `undefined`
= the full DAG; unknown name → loud `UnknownProfileError`); `applyProfile` DROPS the nodes whose `phase ∈
elidePhases` and transitively rewires each survivor's `io.dependsOn` around the hole (`bypass` recurses through
elided deps to the nearest survivor, so `a→v1→b` collapses to `a→b`); `applyProfileByName` does both in one call.
Elision still FUNCTIONS this release but fires behind a loud deprecation `console.warn` in the loader. Resolution
precedence (design §c): the overlay file WINS > legacy `meta.json.profiles` (elision) > a loud unknown-profile error.
Node retirement — the thing elision was really used for — is a separate track; profiles must not elide going forward.

# Anchors
DECLARE (the overlay file shape)
- `packages/core/src/workflow/template/schema/profile.schema.ts:14` — `profileSchema` — fail-closed `{description?, nodes:{<id>:GateEntry[]}}` (additionalProperties:false)
- `packages/core/src/workflow/profile-overlay.ts:32` — `ProfileOverlay` — the parsed-overlay interface (`nodes` = per-node gate additions)
LOAD + MERGE (additive — the LIVE model)
- `packages/core/src/workflow/profile-overlay.ts:45` — `loadProfileOverlay` — read+validate `profiles/<name>.json`; `null` when absent (fall-through)
- `packages/core/src/workflow/profile-overlay.ts:82` — `mergeProfileOverlay` — APPEND each `nodes[<id>]` to that node's `gates[]` (append at :79); unknown id ⇒ loud `ProfileOverlayError`
WIRE (loader)
- `packages/core/src/workflow/template/loader.ts:338` — `loadProfileOverlay` + `mergeProfileOverlay` when `opts.profile` — merges the overlay BEFORE the per-node fan-out ([[gate-composition]])
- `packages/core/src/workflow/template/loader.ts:325` — the `if (m.profiles …)` guard firing the elidePhases deprecation `console.warn`
ELISION (the DEPRECATED-but-reachable predecessor)
- `packages/core/src/workflow/profile.ts:43` — `resolveProfile` — pick the active `ProfileSpec` (name → declared → defaultProfile → undefined)
- `packages/core/src/workflow/profile.ts:95` — `applyProfile` — drop elided nodes + transitively rewire survivor deps; pure, returns a NEW spec
- `packages/core/src/workflow/profile.ts:133` — `applyProfileByName` — resolve + apply in one (the legacy run-path call)
- `packages/core/src/workflow/profile.ts:73` — `bypass` — transitive dependency bypass when a dep is itself elided

# Freshness (anti-drift)
anchors ✓ (all opened 2026-07-07) · scope = the three seeds above · re-derive when they change · DRIFT NOTE:
(1) TWO models share the `--profile` slot and must NOT be conflated: the LIVE additive overlay (`profile-overlay.ts`,
resolution precedence step 1 WINS) and the DEPRECATED elision (`profile.ts`, step 2 — still reachable via
`applyProfileByName`, deprecation-warned at `loader.ts:325`, NOT deleted). The overlay can only ADD gates; elision
SUBTRACTS nodes — mechanically unrelated transforms in one namespace. (2) The overlay's payload is `GateEntry[]`,
whose lowering is owned by [[gate-composition]] — this card owns HOW the overlay/elision resolve + merge, not how the
appended gates fan out. (3) Coverage: the overlay's observable contract IS guarded INTEGRATION-style by
`packages/core/test/gate-list-profiles.test.ts` via `loadTemplate(dir,{profile})` — append merge (`:166`), unknown-node
loud error (`:158`), profile→judge materialize (`:138`), legacy-deprecation warn (`:183`); there is NO direct UNIT
test importing the pure `mergeProfileOverlay`/`loadProfileOverlay` in isolation (a filename-grep for `profile-overlay`
in `test/` returns nothing, which understates the real coverage). Elision is unit-tested at
`packages/core/test/profile.test.ts` + `profile-consumed.test.ts`. (4) The CLI `--profile` end-to-end wiring (the
overlay-file-wins guard in `run.ts`/`entry.ts`) is a documented FOLLOW-ON (design §c Open Q1) — only the load-time
contract is pinned here. Design: `docs/design/gate-list-and-additive-profiles.md` §b/§c. Related: [[gate-composition]].

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/workflow/profile-overlay.ts` | ✓ |
| `packages/core/src/workflow/profile.ts` | ✓ |
| `packages/core/src/workflow/template/schema/profile.schema.ts` | ✓ |

### Evolution arc

- `9d54218` 2026-06-24 — feat(core): generic run-profile node elision + transitive dep rewire
- `2e125ad` 2026-07-06 — feat(core): schema + types for the additive gate list and profile overlay
- `e9c58ee` 2026-07-06 — feat(core): gate-list fan-out + profile-overlay loader modules
- `f157e62` 2026-07-07 — chore(okf): re-stamp anchors after the profile-overlay run-path move + refresh auto regions

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[blueprints-layer]]
- [[claude-code-executor]]
- [[competitive-gaps-pdw]]
- [[default-profile-programmatic-gates-only]]
- [[design-at-init-architecture]]
- [[flexibility-over-hardcoded-plans]]
- [[issue-lifecycle-gate-redesign]]
- [[omniscience-lesson-quality-phase]]
- [[omniscience-piflow-setup]]
- [[piflow-ci-cd-pipeline]]
- [[verify-nodes-never-in-dev-arms]]
- [[writer-fails-at-wiring-seams]]

### Code anchors / blast radius (codegraph)

- `UnknownProfileError` (packages/core/src/workflow/profile.ts:21) — 3 callers in `packages/core/src/index.ts`, `packages/core/src/workflow/profile.ts`; tests: `packages/core/test/profile.test.ts`
- `applyProfileByName` (packages/core/src/workflow/profile.ts:133) — 7 callers in `packages/core/src/runner/entry.ts`, `packages/cli/src/run.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/profile.test.ts`
- `loadProfileOverlay` (packages/core/src/workflow/profile-overlay.ts:56) — 3 callers in `packages/core/src/workflow/template/loader.ts`, `packages/core/src/index.ts`; ⚠ no covering tests found
- `ProfileOverlayError` (packages/core/src/workflow/profile-overlay.ts:24) — 4 callers in `packages/core/src/workflow/template/loader.ts`, `packages/core/src/index.ts`, `packages/core/src/workflow/profile-overlay.ts`; ⚠ no covering tests found
- `applyProfile` (packages/core/src/workflow/profile.ts:95) — 3 callers in `packages/core/src/workflow/profile.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/profile.test.ts`

<sub>derived 2026-07-24 · arc=4 commits · files=3 · lessons=12</sub>
<!-- okf:auto-end -->

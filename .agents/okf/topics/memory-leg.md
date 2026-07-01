---
type: subsystem
key: memory-leg
title: Memory layer (the two legs — Leg A self/history · Leg B world/code)
description: How each node gets two optimizer-facing markdown surfaces — memory.md (standing behavior + failure lessons) and code-map.md (a Tier-0 OKF slice of its scope) — seeded PURE create-if-absent by the scaffolder, never injected into the node's runtime prompt, intended only for the Hermes optimizer to read and update.
resource: packages/core/src/memory/skeleton.ts
aliases: [memory.md, code-map, code-map.md, memory-leg, buildNodeMemory, buildSystemMemory, buildNodeCodeMap, seedNodeMemory, seedNodeCodeMap, Leg A, Leg B, hermes, optimizer-facing, self/history, world/code, resolveSlice, DefectScope, cross-reference, pointer-resolve, resolve-at-read, freshness-ride]
seeds: [packages/core/src/memory/skeleton.ts, packages/core/src/memory/seed.ts, packages/core/src/memory/index.ts, packages/core/src/code-map.ts, packages/core/src/index.ts, packages/cli/src/scaffold.ts, packages/cli/src/cli.ts, packages/cli/src/understand.ts]
symbols: [buildNodeMemory, buildSystemMemory, buildNodeCodeMap, seedNodeMemory, seedSystemMemory, seedNodeCodeMap, writeIfAbsent, scaffoldMemory, resolveSlice]
tags: [memory, optimizer, scaffold, core, cli, self-correction]
timestamp: 2026-06-30
---

# Why / how it works (the lifecycle, end to end)
Each node carries two optimizer-facing markdown legs. Leg A (self/history) is `memory.md`: standing
behavior + generalized failure LESSONS + a `git log --grep '^skillsys(<id>)'` pointer, built PURE from the
id by `buildNodeMemory` (per-node) and `buildSystemMemory` (the template reconcile summary). Leg B
(world/code) is `code-map.md`: one Tier-0 OKF reference slice of the product code in the node's scope, built
by `buildNodeCodeMap`. The seeds are written create-if-absent by `seedNodeMemory` / `seedSystemMemory` /
`seedNodeCodeMap`, each guarded by `writeIfAbsent` so a re-seed NEVER clobbers curated content (memory
accumulates). The CLI scaffolder wires this in: `scaffoldNew` seeds the system `memory.md`; `scaffoldAddNode`
seeds the node's `memory.md` + `code-map.md`; `scaffoldMemory` backfills an existing template (the
`piflowctl memory scaffold` engine). All six builders/seeders are lifted to the `@piflow/core` root. The legs
are OPTIMIZER-FACING — never injected into a node's runtime prompt (a node must not see its own failure
history). The consumer is the out-of-band Hermes optimizer, and the READERS now exist: Leg A's recurrence
reader (`optimize/triage.ts`) flips a recurring failure LAPSE→SKILL, and the **two legs are joined by a single
cross-reference** — a lesson's `[[okf-slice]]` link names the Leg-B slice it concerns; `resolveSlice`
(`understand.ts`) dereferences that key to the slice's curated code-map; and the optimize CLI seam inlines it
into the fixer's `DefectScope.codeMap` at fix time, so the fixer reads *what recurred* (Leg A) alongside *how
the code works* (Leg B). The join is **POINTER + RESOLVE-AT-READ, never an embedded copy** — the "pointers +
semantics, never a copy" law (v1 §5b), re-confirmed 2026-07-01 by both an external SOTA sweep and our own prior
research: memory stores only the KEY, the code-map is a fresh read of the drift-gated slice (so it can never
rot), and a lesson's freshness RIDES that slice's `--check`. An embedded copy was rejected precisely because it
would have no `--check` to ride (see `docs/research/memory/piflow-memory-v1.5.md`).

# Anchors
DEFINED
- `packages/core/src/memory/skeleton.ts:15` — `buildNodeMemory()` — PURE per-node `memory.md` seed (Leg A)
- `packages/core/src/memory/skeleton.ts:45` — `buildSystemMemory()` — PURE template reconcile-summary seed (Leg A)
- `packages/core/src/code-map.ts:35` — `buildNodeCodeMap()` — PURE per-node Tier-0 OKF slice seed (Leg B)
- `packages/core/src/memory/seed.ts:17` — `writeIfAbsent()` — create-if-absent guard (never clobbers curated content)
SEEDED (at scaffold time)
- `packages/cli/src/scaffold.ts:391` — `scaffoldNew` → `seedSystemMemory` — seeds the template's system `memory.md`
- `packages/cli/src/scaffold.ts:407` — `scaffoldAddNode` → `seedNodeMemory` + `seedNodeCodeMap` (line 237) — seeds both legs per node
- `packages/cli/src/scaffold.ts:440` — `scaffoldMemory()` — backfill engine for `piflowctl memory scaffold`
CONSUMED (the out-of-band optimizer reads the legs; NEVER a worker node)
- `packages/core/src/optimize/recurrence.ts:49` — `deriveRecurrence` — reads `memory.md` lesson blocks → RecurrenceIndex (the Leg-A reader; `triage` flips LAPSE→SKILL on it)
- `packages/cli/src/understand.ts:136` — `resolveSlice` — dereference a lesson's `[[okf-slice]]` link to the linked slice's curated body (the Leg-A → Leg-B join)
- `packages/cli/src/optimize-fix.ts:143` — `enrichCodeMap` — the CLI seam inlines the resolved code-map into `DefectScope.codeMap` at fix time (resolve-at-read)

# Freshness (anti-drift)
anchors ✓ · scope = the seeds above · re-derive when they change · DRIFT NOTE: no longer seed-only — the READERS shipped. Leg A's recurrence reader (`optimize/triage.ts`) + the cross-reference resolver (`resolveSlice`, `understand.ts`) now feed the optimizer's `DefectScope` (pointer + resolve-at-read; the join lives in `optimize-fix.ts`). What remains DEFERRED: LLM-distilled root/prevention (MEMORIZE writes deterministic placeholders today) and cap/retire compaction of `memory.md`. `index.ts` is marked `// STUB — RED phase` though the facade is wired + root-exported — verify that label.

<!-- okf:auto-start -->
> _Auto-generated by `_generate.mjs` — do not hand-edit between the markers; re-run `--write`._

### Final state — file set (seeds)

| File | exists |
|---|---|
| `packages/core/src/memory/skeleton.ts` | ✓ |
| `packages/core/src/memory/seed.ts` | ✓ |
| `packages/core/src/memory/index.ts` | ✓ |
| `packages/core/src/code-map.ts` | ✓ |
| `packages/core/src/index.ts` | ✓ |
| `packages/cli/src/scaffold.ts` | ✓ |
| `packages/cli/src/cli.ts` | ✓ |

### Evolution arc

- `c5d6850` 2026-06-21 — feat(core): scaffold @piflow/core + freeze the L1 types spine
- `e570755` 2026-06-21 — feat(core): DAG compiler + contract codec + registry + sandbox + hooks
- `55eb576` 2026-06-21 — feat(core): M1 runner — execution loop over the spine
- `efe18e6` 2026-06-21 — feat(core): Seatbelt read-scope SandboxProvider (macOS) — M1 isolation
- `603dd7c` 2026-06-21 — feat(core): MCP tools/list → ToolEntry ingestion (the effortless catalog fill)
- `9d0d019` 2026-06-21 — feat(core): generate the pi -e extension that binds sdk/mcp tools
- `b4641c0` 2026-06-21 — feat(core): per-node tool bind pre-check (verifyToolBinding)
- `a4751de` 2026-06-21 — feat(core): wire outside tools end-to-end — resolve generates the -e, runner stages it + bind-gates each node
- `8d93917` 2026-06-21 — feat(core): wire Daytona against the real @daytona/sdk (adapter + factory)
- `b1c65e4` 2026-06-21 — feat(core): WorktreeSandboxProvider — per-run git WRITE isolation on the RunScope seam
- `5cf500a` 2026-06-21 — feat(core): port the unified node contract — checks/policy/return/schema gates
- `b3bf68d` 2026-06-21 — feat(core): bundle generated -e + OpenClaw sdk lane + per-node MCP config staging
- `3a3bee1` 2026-06-21 — feat(core): wire OpenClaw sdk seeding — persisted searchable catalog + lean-bundle subpath
- `0df5954` 2026-06-22 — feat(core): seed catalog with curated real OpenClaw community tool plugins
- `0d242aa` 2026-06-22 — feat(core): pluggable SecretResolver seam — scoped-token broker for cloud MCP secrets
- `fe75d94` 2026-06-23 — feat(core): run observability — per-node event capture + `piflow logs`
- `0321415` 2026-06-23 — fix(core): harden run capture against pi's cumulative-snapshot bloat
- `8759886` 2026-06-23 — feat(core): run diagnosis (`logs --summary`) + static tool audit + observability doc
- `24defb1` 2026-06-23 — feat(core): LocalSandboxProvider — in-place 'local' sandbox kind (U2)
- `22291d4` 2026-06-23 — feat(core): extractWorkflow — record realized prompts + DAG from a workflow .js (U5)
- `6518272` 2026-06-23 — feat(core): RunState channels/reducers + per-run .pi/ layout + io.json writer (U6a)
- `0794e2c` 2026-06-23 — feat(core): template-format JSON schema + min fixture + validation test (T1)
- `e4902c5` 2026-06-23 — feat(cli): @piflow/cli status + watch over the .pi/ run layout
- `d9b3118` 2026-06-23 — feat(core): loadTemplate compile gate (T2)
- `7418442` 2026-06-23 — merge: T2 — loadTemplate compile gate (feat/t2-loadtemplate)
- `71adc2f` 2026-06-23 — feat(core): {{RUN}}/{{WORKSPACE}}/{{state}} resolver (U7)
- `f1b3044` 2026-06-23 — feat(core): run-observability source — readRunModel + watchRun
- `31e5ea8` 2026-06-23 — feat(core): seed/project/merge op executors on the logical-root resolver (U7)
- `d50532b` 2026-06-23 — feat(core): promote POST-op + DRIVER-PROMOTE codec + stage-barrier merge (U7)
- `0d80781` 2026-06-23 — merge: T4 — U7 {{state}}/{{WORKSPACE}}/{{RUN}} resolver + seed/project/merge ops + promote + barrier-merge (feat/t4-resolver-ops)
- `dc60d9e` 2026-06-23 — refactor(cli): consume @piflow/core/observe — delete the bespoke .pi/ readers
- `66935dd` 2026-06-23 — merge: P2 — CLI+TUI become thin renderers of @piflow/core/observe; NodeRecorder events → .pi/ (feat/obs-surfaces-refactor)
- `a49cdb6` 2026-06-23 — feat(core): init(${RUN}) instantiation (U8)
- `62cbc0c` 2026-06-23 — feat(core): runFromConfig + loadConfig (U8)
- `334208d` 2026-06-23 — feat(cli): piflow run [--dry-run] and wire run+extract dispatch
- `bf9073b` 2026-06-23 — fix(tools): register submit_result as a real first-party contract tool
- `1df3a36` 2026-06-23 — feat(core): carry node ops + resolve {{arg}}/{{state}} at node launch
- `91e88cf` 2026-06-23 — feat(ops): seed PRE executor — stage {to,from} skeletons (ports run.mjs copy)
- `a6f974a` 2026-06-23 — feat(core): runFromTemplate joins loadTemplate+instantiate+run; --arg channel (S5)
- `1a3fa37` 2026-06-23 — feat(cli): real run — route LIVE through core runFromTemplate, thread args/workspace/sandbox
- `183b9aa` 2026-06-23 — feat(cli): inspect — per-node RESOLVED view (sandbox · tools · ops · prompt)
- `8aad7fc` 2026-06-23 — feat(core): wire seedContracts + genre-projection POST-ops into the run loop (P2/P3)
- `6d9b4b1` 2026-06-23 — refactor(core): complete the SDK de-game-ification — T1/2 core (recovered) + T3 relocation
- `51c8bdf` 2026-06-24 — feat(cli): piflow gui — launch the run viewer from anywhere
- `9e3fa07` 2026-06-24 — feat(core): generic run-profile node elision + transitive dep rewire
- `9ec0710` 2026-06-24 — feat(core): docker-style <adjective>-<pie> auto-naming for runs
- `cfcb972` 2026-06-24 — refactor(tui): move @piflow/tui to top-level beside gui
- `95b825c` 2026-06-25 — feat(core): surface buildRunView at the package root
- `91f788b` 2026-06-25 — feat(core): the G5 checkpoint runner lane — park (no slot), validate, journal, resume
- `9c64f0c` 2026-06-25 — feat(core): model-routing.ts — the one home of model/provider precedence (G1)
- `42e5e26` 2026-06-25 — feat(core): agent-preset.ts — pure mergePreset + read-only catalog adapter (G6)
- `47164cd` 2026-06-25 — feat(core): expandFusion — siblings+judge DAG expansion as preset agents (T2.2)
- `26a3620` 2026-06-25 — feat(core): fusion-config.ts — read-only ~/.piflow/fusion.json defaults reader (T2.3)
- `83fc3c8` 2026-06-25 — fix(cli): a canonical run home is never relocated by --out
- `2b1f8d1` 2026-06-25 — feat(core): G9 — subworkflow sub-DAG inlining (expandSubworkflow)
- `a3fdf7a` 2026-06-25 — feat(core): expandReroute — unroll the bounded QA loop into a forward-only acyclic DAG with a zero-pi #17 short-circuit (M3, closes #2/#5/#17)
- `8e6cc9a` 2026-06-25 — fix(core): M6 surface OpenClaw hook-bus registrations as advisory, not silent (#20)
- `0564114` 2026-06-26 — merge: integrate main (G3/G6/G7/G9) into the node-action M0–M7 lineage
- `169cb6d` 2026-06-26 — feat(observe): lift the fleet registry + discovery into @piflow/core
- `e78f94c` 2026-06-26 — refactor(cli): rename global bin piflow → piflowctl
- `9636137` 2026-06-26 — feat(core): withNodeFusion toggle + previewView projection
- `41159ef` 2026-06-26 — feat(sandbox): default-on read-scope jail for --sandbox local
- `779f327` 2026-06-26 — feat(sandbox): Linux bwrap backend + OS-dispatched local jail (kernel path PENDING Linux verify)
- `d074a39` 2026-06-26 — feat(catalog): feed the ~/.piflow catalog slice into the run path so mcp.* nodes bind
- `369d7d3` 2026-06-26 — feat(catalog): sync() — federate the MCP Official Registry server directory into ~/.piflow
- `408823a` 2026-06-26 — feat(catalog): introspectMcpServer — capture a server's tools/list into per-tool entries (binding closes)
- `ed46d99` 2026-06-26 — feat(sandbox): M1c — boot daytona from a promoted snapshot (default) + ripgrep + promote script
- `a300f56` 2026-06-26 — feat(observe): telemetry projection — agent-facing lens over the run-view
- `11430e9` 2026-06-26 — feat(cli): piflowctl telemetry — agent-facing digest, record + --watch stream
- `f75ae34` 2026-06-26 — Merge feat/sandbox-daytona-m1 into main
- `be2f36b` 2026-06-26 — feat(e2b): @piflow/e2b installable sandbox extension + CLI choose-to-install wiring
- `08c153a` 2026-06-27 — refactor(daytona): extract the Daytona cloud backend into @piflow/daytona
- `8dba310` 2026-06-27 — feat(cli): scaffold templates from flags (piflowctl new / add-node)
- `d9035b4` 2026-06-27 — feat(core)!: U6 — retire node.ops/NodeOps; op[] is the sole derive rep
- `49f9d3d` 2026-06-27 — feat(cli): scaffolder emits canonical op[] for the five derive hooks
- `b9433ca` 2026-06-27 — feat(cli): wire --seed/--promote/--project/--merge-run/--registry-project flags
- `a7ba897` 2026-06-27 — feat(core): unify op[] gate/run readers into op-dispatch; fail loud on undispatchable run ops
- `52f05ec` 2026-06-28 — feat(core): gate authoring → op[] lowering + retry.scope (SA-B)
- `df8189b` 2026-06-28 — feat(cli): piflowctl node <run> <id> --resume (warm-resume a node from its stored session)
- `19addba` 2026-06-28 — feat(cli): piflowctl node <run> <id> --stop — signal a detached run's process (reuse the kill seam)
- `2ddf66d` 2026-06-28 — feat(cli): piflowctl model + lazy ~/.piflow bootstrap (seed model-tiers)
- `a52e6c9` 2026-06-29 — feat(executor): template + CLI authoring can select the claude-code executor
- `81200ca` 2026-06-29 — feat(cli): the skippable claude-code executor setup flow (connect + model --claude)
- `f9c63b1` 2026-06-29 — feat(cli): interactive, modular `piflowctl init` wizard (model tiers + optional claude-code)
- `d4418c5` 2026-06-29 — feat(core): memory layer SDK — per-node/template memory.md + code-map seeds
- `4415ae9` 2026-06-29 — feat(core): per-node fullAccess flag — open the fs jail for one node
- `bcd44ef` 2026-06-29 — feat(cli): seed the memory layer from new/add-node + `memory scaffold` backfill
- `a935280` 2026-06-29 — merge: claude-code 2nd node executor + interactive piflowctl init wizard
- `49bc78f` 2026-06-29 — feat(cli): --agent-type <id> binds a base agent preset to a scaffolded node
- `d71e46c` 2026-06-29 — feat(core): inherit agentType preset role-prompt at render time
- `4cbf1ad` 2026-06-30 — fix(cli): implement `piflowctl --version` (-v/-V)
- `c4d79a0` 2026-06-30 — feat(cli): piflowctl optimize <run> — the Score+Triage accessor (lands nothing)
- `633f9d3` 2026-06-30 — feat(core): lift the FIX→GATE→LAND + replay/mine surface to the @piflow/core root
- `05a98a7` 2026-06-30 — feat(cli): piflowctl optimize --fix --binding — the product→optimizer injection seam (v1.5 §6)
- `6795a9d` 2026-06-30 — feat(cli): optimize --fix --node <substr> — scope the worklist to one node
- `5bd7c75` 2026-06-30 — feat(optimize): native live streaming — OptimizeEventSink + optimize --fix --watch
- `38adfad` 2026-06-30 — feat(cli): full check vocabulary (severity/param/pre lane) + policy.warn
- `9ad4a7b` 2026-06-30 — feat(cli): judge gate (--judge, rubric from judge.md) + checkpoint (G5 HITL)
- `ca73114` 2026-06-30 — feat(cli): execution gate (--gate-run) + escalate/reroute control actions
- `70e5464` 2026-06-30 — feat(cli): fusion + subworkflow topology + contract extras (fullAccess/fillSentinel)
- `ca3cac6` 2026-06-30 — docs(cli): document the full node-authoring surface (--help + piflow-init skill) + changeset
- `56d2d37` 2026-06-30 — feat(cli): self-describing `piflowctl schema` — print the SDK authoring schemas
- `476da6d` 2026-06-30 — feat(cli): `piflowctl skills install` — ship the workflow-authoring skills into a target repo
- `ee12eee` 2026-06-30 — refactor(cli): make `piflowctl schema` a topic-segmented authoring reference
- `e63fc09` 2026-06-30 — Merge feat/cli-schema-command: self-describing topic-segmented `piflowctl schema`
- `dcf97ae` 2026-06-30 — Merge branch 'main' into feat/optimize-prove-landing
- `991cb7f` 2026-06-30 — feat(optimize): SDK-level fix-cycle ceiling (portable per-node re-attempt bound + fix-cycle-ceiling event)
- `8ab0a7c` 2026-06-30 — refactor(cli)!: op[]-canonical `schema ops` topic + rename --schema→--artifact-schema (A1/A4)
- `47ddf72` 2026-06-30 — Merge fix/op-authoring-surface: robust A-series authoring-surface fixes
- `859c767` 2026-06-30 — feat(cli): skills install add-ons + wizard + per-project manifest
- `cc65e95` 2026-06-30 — refactor(core): lift project-scope resolution into @piflow/core (shared)
- `ed90d7c` 2026-06-30 — feat(tui): scope the terminal fleet view to the launched project + add `piflowctl tui`
- `240da26` 2026-06-30 — feat(optimize): Leg-A recurrence reader — fills the deferred SKILL bucket in triage

### Lessons — memory cluster

**Alias matches** (review — may include false positives):
- [[codebase-memory-mcp-analysis]]
- [[expert-representations]]
- [[game-omni-reference-product]]
- [[node-illustration-pipeline]]
- [[piflow-memory-system-v1]]
- [[piflow-optimize-layer-built]]
- [[piflow-product-positioning]]

### Code anchors / blast radius (codegraph)

- `seedNodeMemory` (packages/core/src/memory/seed.ts:30) — 6 callers in `packages/cli/src/scaffold.ts`, `packages/core/src/index.ts`, `packages/core/src/memory/index.ts`; tests: `packages/core/test/memory.test.ts`
- `seedNodeCodeMap` (packages/core/src/code-map.ts:59) — 5 callers in `packages/cli/src/scaffold.ts`, `packages/core/src/index.ts`; tests: `packages/core/test/code-map.test.ts`
- `buildNodeMemory` (packages/core/src/memory/skeleton.ts:15) — 5 callers in `packages/core/src/memory/seed.ts`, `packages/core/src/index.ts`, `packages/core/src/memory/index.ts`; tests: `packages/core/test/memory.test.ts`
- `seedSystemMemory` (packages/core/src/memory/seed.ts:36) — 6 callers in `packages/cli/src/scaffold.ts`, `packages/core/src/index.ts`, `packages/core/src/memory/index.ts`; tests: `packages/core/test/memory.test.ts`
- `scaffoldMemory` (packages/cli/src/scaffold.ts:440) — 2 callers in `packages/cli/src/scaffold.ts`; tests: `packages/cli/test/scaffold-memory.test.ts`

<sub>derived 2026-07-01 · arc=113 commits · files=7 · lessons=7</sub>
<!-- okf:auto-end -->

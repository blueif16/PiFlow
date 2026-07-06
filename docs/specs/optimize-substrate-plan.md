# Optimize Substrate — implementation plan

> The per-node optimization substrate: a SECOND optimization system beside the shipped routing loop
> (`piflowctl optimize <rundir>`), sharing its staging/adopt philosophy but replacing the programmatic
> one-defect-per-node triage with a measurement → issue-decomposition → per-issue-fix pipeline.
> Locked design contract: the 2026-07-05/06 grilling session. Research grounding:
> `docs/research/2026-07-05-per-node-optimization-substrate-sota.md` and
> `docs/research/2026-07-05-issue-ledger-schema-sota.md`. Seam recon: the 5-lane workflow of 2026-07-06
> (facts cited inline as `file:line`).
> Demo target: game-omni run `tS2`, node `gameplay`. The shipped optimize code is NOT moved or renamed.

## 0 · Shape of the whole

```
piflowctl optimize triage --node gameplay --topk 3      # phase 1 only
piflowctl optimize fix    --node gameplay [--status open | --issue <name>] [--watch]
piflowctl optimize        --node gameplay --topk 3      # both phases
piflowctl issues          --node gameplay [--status open] [--json]   # read-only query (top-level verb)
```

- Module: `packages/core/src/optimize/substrate/` — sibling files inside the existing optimize module.
  Imports shipped primitives (`evaluateGate`, `writeStagingManifest`, `adoptFile`, events pattern);
  never touches `memorize.ts` (memory system out of scope — confirmed self-contained, memorize.ts:61).
- Operator = the agent (triage/fixer agents drive the CLI); the human reads `issues` and runs adopt.
- Everything config-with-defaults; declarations via token-resolved paths in `node.json`.

## 1 · Milestones

### M0 — `optimize` block on node.json (schema + scaffold mirror)
The anti-drift contract (node.schema.ts is `additionalProperties:false` — any unknown top-level key
fails the WHOLE template load, checks.ts:29):
1. `packages/core/src/workflow/template/schema/node.schema.ts` — add top-level `optimize`:
   ```json
   "optimize": { "type": "object", "additionalProperties": false, "properties": {
     "measure": { "type": "array", "items": { "$ref": "#/$defs/op" } },
     "judge":   { "type": "string" }
   }}
   ```
   `measure` reuses the EXISTING `$defs/op` shape byte-for-byte (gate/run bodies are the meaningful
   ones post-run). `judge` = token-resolved path to the soft-judge skill/prompt file.
2. `packages/cli/src/scaffold.ts` `buildNode` — mirror emit block (only-when-authored, like `fusion`
   at scaffold.ts:364).
3. Loader `toNodeIntent`: **skipped deliberately** — the block is optimizer-facing; consumers read
   `<templateDir>/nodes/<id>/node.json` directly via fs (precedent: memory.md / recurrence.ts:49).
4. Tests (red-bar first): template with `optimize` block loads clean; unknown key inside it rejected;
   scaffold round-trips through the real `loadTemplate` (scaffold.test.ts pattern, comment L11-12).

### M1 — Run identity: date-seq names, child runs, lineage fields
1. `packages/core/src/names/`: `generateDateSeqName(existing, now)` — `YYMMDD-NN`, zero-padded
   per-day counter, same `(existing, rng?) ⇒ string` collision-retry contract as `generateRunName`
   (generator.ts:40-55). `now` injected for testability. `childRunName(parentId, nodeId, existing)`
   → `<parent>.<nodeId>` then `.<n>` (bare = implicit first). Rule enforced at mint: base names are
   dot-free; dots are lineage-only. Dot-safety: audited safe at every parse site (recon Q3 table).
2. `run.ts:520` default generator swaps to date-seq (pie names are reassigned to issue naming).
   **Consumer-facing change → changeset required** (@piflow/cli + @piflow/core).
3. `RunStatus` (status.ts:209): add `parent?: string; spawnedBy?: { by: string; issue?: string;
   issueId?: string }` — additive-optional, threaded via `RunOptions` (runner.ts:65-75) into the
   `ctx.status` literal (runner.ts:451-478), same pattern as `promptId`.
4. `substrate/child-run.ts` — `spawnChildRun(parentRunDir, nodeId, { templateDir, spawnedBy, workspace? })`:
   - mint child id; `unpackRunDir(await packRunDir(parent, …), childDir)` **excluding
     `.pi/journal.json`** — no journal entry ⇒ the target node unconditionally RUNs
     (journal.ts:219-221) while the skipped prefix is force-`reused` (runner.ts:543) and the
     artifact preflight passes because the whole tree was copied (runner.ts:578-611);
   - `runFromTemplate(templateDir, { runDir: childDir, run: childId, from: nodeId, until: nodeId,
     parent, spawnedBy, …provider/model carried from parent run.json })`.
5. Tests: name generators (collision, padding, day rollover); spawnChildRun on a tiny fixture
   template — child re-runs ONLY the target node, run.json carries parent/spawnedBy.

### M2 — The issue ledger (`substrate/issues.ts`)
Physical shape: `template/nodes/<id>/issues/<name>.md` — the directory IS the table.
```
---
id: sha256:…            # tool-computed, never agent-written
name: soggy-crust       # pie-generated (generateRunName against existing issue names)
title: <rewritable one-liner>
severity: high          # critical|high|medium|low
status: open            # open|active|fix-landed|verifying|resolved|regressed
reason: null            # fixed|wontfix|false-positive|superseded (set on close)
sig: gameplay::compose-in-thinking   # the STABLE identity line (see hash recipe)
firstSeen: 260706-01
lastSeen: 260706-01
attempts: []            # append-only: [{commit, verifiedByRun, regressedIn}]
---
<~30–40 line context brief — REWRITTEN by triage on every reopen (facts append, prose is curated)>
```
- **Hash recipe (versioned, prospective-only):** `id = sha256("v1\n" + nodeId + "\n" + sig)`.
  For hard-check issues `sig` is mechanical (`<node>::<ruleId>::<normalized-location>`); for judge
  issues the triage agent authors a stable `sig` tag reusing game-omni's existing memory.md
  convention (`sig: <node>::<tag>` — the format already in production, memory.md recon §4).
  Excluded from the hash: timestamps, run ids, line numbers, prose (SARIF/Sentry findings).
- **Dedup/reopen is two-layer:** the triage agent reads the existing ledger first and writes into
  the matching file (semantic match — primary); the tool's hash equality is the mechanical backstop
  and the recurrence auto-linker. Reopen = same file: status flips, `lastSeen` stamps,
  `regressedIn` fills on the last attempt, context rewrites. Never a duplicate file.
- API: parse/write/validate one issue file; `listIssues(templateDir, {node, status})`;
  `stampAttempt`, `reopen`, transition guards. All mutations mechanical (the agent writes drafts;
  the tool computes id/name/firstSeen — M4).
- Tests: frontmatter round-trip; hash stability under title/prose/run changes; reopen-not-duplicate;
  attempts append-only; status-machine transition guards (invalid transition throws).

### M3 — Hard measurement stage (`substrate/measure.ts` + `substrate/trace-metrics.ts`)
Fully external to the runner — reuses the op READER + pure EXECUTORS; `node-lifecycle.ts` untouched:
1. Read the node's `optimize.measure` op[] directly off node.json; build a standalone `ResolveCtx`
   `{ run: runDir, workspace, state: JSON.parse(stateFile(runDir)) }` (resolver.ts:25; state from
   layout.ts:21); resolve with `resolveDeep`. (`{{arg.*}}` is not persisted post-run — documented
   unsupported in measure ops.)
2. Fire: `gatesFromOp(ops).post` → `evaluateChecks(checks, readFromRunDir)` (checks.ts:117);
   `runOpsFromOp(ops).runnable` → `applyMergeOp({run}, runDir)` (merge.ts:58). Collect reports.
3. Built-in trace detectors (generic pi-event parsing, product-agnostic ⇒ core-legal), over
   `.pi/nodes/<id>/events.jsonl` (schema per recon §1):
   - **thinking-stall**: `thinking_end.content` length + `_t` span per block; flag > thresholds.
   - **tool-loop**: group `tool_execution_*` by `(toolName, JSON.stringify(args))`; flag ≥N repeats
     with byte-identical results (handle the `truncated:true` result shape).
   - **token-waste**: `turn_end.usage` — cumulative input growth + `cacheRead:0` cache-miss flag.
   - plus fold `projectRunDigest(buildRunView(runDir))` anomalies (the public seam score.ts:93-98
     already uses; `detectAnomalies` itself is module-private — not importable, not duplicated).
4. Output: `<runDir>/optimize/substrate/measure.<node>.json` — one deterministic report the triage
   agent consumes verbatim. Thresholds config-with-defaults (mirroring `TelemetryThresholds`).
5. Tests: each detector against synthetic events.jsonl fixtures that FAIL when the detector is wrong
   (span too short → no flag; identical-args-different-results → no flag); real-fs op firing with a
   fixture script; report determinism.

### M4 — Soft judge = the triage agent (`substrate/triage.ts` + `substrate/agent.ts`)
1. `substrate/agent.ts` — the ONE thin spawn wrapper (never hand-rolled `spawn('claude',…)`):
   builds a literal one-node `WorkflowSpec` (`executor:'claude-code'`) and calls
   `runFromConfig` (entry.ts:88) — credentials, model routing, sandbox jail, `parseClaudeResult`,
   `NodeStatusRecord` telemetry all inherited. Model default: `tiers.claude?.deep ?? 'sonnet'`
   via the real `loadModelTiers()` (model-routing.ts:196), overridable per call/env — the
   "sonnet default" is substrate policy, core routing stays policy-free.
2. Triage flow per (node, run): assemble the prompt from the node's `optimize.judge` skill file +
   the measure report + criteria anchor + gold path + memory.md + the git-search instruction
   (`git log --grep '^skillsys(<node>)'` — the convention confirmed live in game-omni);
   `readScope` = run dir + template node dir + declared product paths; `owns` = the node's
   `issues/` dir. The agent: reads existing issues first (reopen-over-create), then writes
   issue DRAFTS (no id/name/firstSeen) or edits existing files' context/severity.
3. Post-process (mechanical, tool-side): validate every touched file; compute `id` from `sig`;
   mint pie `name`s for new drafts; stamp firstSeen/lastSeen; hash-dedup backstop (merge drafts
   that collide with existing ids into a reopen). Cap: new-issues-per-pass limit (default 5).
4. Stamp the analyzed marker `<runDir>/optimize/substrate/triaged.<node>.json` ({when, issues[]}).
5. Separation law in the judge prompt: identify + contextualize ONLY (severity, suspect scope,
   evidence pointers, history) — zero fix proposals. Criteria/gold are judging references,
   NEVER injected into the worker node's own prompt.
6. Authoring deliverables: the soft-judge prompt TEMPLATE (piflow-side:
   `docs/design/substrate-judge-template.md`, structured per agentic-prompt-design — bar/coverage/
   self-check slots) + game-omni's concrete judge file (product-side, M7).
7. Tests: post-processor (drafts → identity-stamped files; collision → reopen; cap enforced);
   prompt assembly (all inputs present, criteria anchor resolves). Agent behavior itself is
   proven by the M7 live demo (eval, not unit — test-discipline).

### M5 — CLI verbs (`packages/cli/src/issues.ts` + optimize dispatch)
1. Dispatch (cli.ts:335-345) — subverbs FIRST, then legacy flags, classic fallthrough unchanged:
   ```
   if (rest[0] === 'triage')      → runSubstrateTriageCli(rest.slice(1))
   else if (rest[0] === 'fix')    → runSubstrateFixCli(rest.slice(1))
   else if (rest.includes('--rounds' | '--adopt' | '--fix'))  → classic paths (unchanged)
   else if (no positional && rest.includes('--node'))         → substrate full loop
   else                            → runOptimizeCli (classic <rundir>)
   ```
   The recon-flagged trap (bareword read as rundir) is dead because subverbs are consumed before
   any parser sees positionals. Classic `--node`/`--fix` flag semantics untouched.
2. `--topk K` selection: scan the product's runs home; keep runs where run.json shows this node
   executed fresh (`nodes[id].status` ok/error, not `reused`); order by startedAt; take the newest
   K lacking the triaged marker. Default K=1.
3. Top-level `issues` verb: registration copies the `blueprint` pattern exactly (cli.ts:389-393
   region + HELP block; internal `list|show` sub-dispatch per blueprint.ts:109-116). `--json` for
   agents, table for humans. Resolves the template dir the same way optimize does
   (`templateDirFor`, optimize-fix.ts:172, or explicit `--template`).
4. Tests: dispatch-routing unit tests (every row above routes correctly — esp. `optimize fix` vs
   classic `optimize --fix <rundir>`); arg parsers; issues list/show against a fixture ledger.

### M6 — Fix phase (`substrate/fix.ts` + events + adopt-commit)
Per selected issue (sequential for the demo; the loop is per-issue so parallel is a later flag):
1. `status → active` stamped on dispatch. Candidate copy via the product's `copyScope`
   (game-omni scope.mjs — extended in M7 to cover gameplay's editable scope: the harden-blueprint
   skill dir + archetype module + template node dir).
2. Fixer agent via `substrate/agent.ts`: prompt = the issue FILE (path is the whole dispatch
   contract) + fix contract (root-cause the issue, edit the candidate, commit nothing); sandbox
   `execCwd = candidateRef` + `execReads` (the E10 seam, types.ts:245 — built for exactly this).
   `editsApplied` from the product's before/after diff (stays product-side, binding-live.mjs:56-79
   precedent).
3. Prove (self-rewind): `spawnChildRun(parentRunDir, nodeId, { workspace: candidateRef,
   spawnedBy: {by:'substrate-fix', issue} })` → re-run M3 measure (+ judge, config) on the child →
   delta vs the parent's measure report → `evaluateGate`-shaped strict-improvement decision
   (gate.ts:42 reused; unmeasurable ⇒ stage-for-human, never auto).
4. Stage: substrate manifest (writeStagingManifest-shaped, per-issue records). **Adopt** (separate
   human verb, philosophy unchanged): `adoptFile` per real file (land.ts:92, symlink-safe walk) into
   the live product, then the NET-NEW `commitAdoption(repoRoot, files, issue)` —
   `execFileSync('git', ['-C', root, 'add'|'commit', …])` following the worktree.ts:64 precedent,
   message trailer `Issue: <node>/<name> — "<title>" (<hash7>)`. SHA captured from the commit
   output and stamped mechanically: `attempts += {commit, verifiedByRun: <childId>}`,
   `status → resolved, reason: fixed`. No human, no agent prose in the loop.
5. `SubstrateEvent` union + own `safeEmit` copy + `renderSubstrateEvent`; CLI `--watch`/`--watch-json`
   reuse the optimize-fix.ts rendering split.
6. Tests: gate arithmetic (reused — already covered) + the wiring around it; `commitAdoption`
   against a temp git-repo fixture (trailer format, SHA capture, no-op on empty diff); attempts
   stamping; event order.

### M7 — game-omni binding + the LIVE demo (the acceptance gate for the whole build)
Product-side contributions (all recorded in game-omni, per its conventions):
1. `nodes/gameplay/node.json` gains the `optimize` block:
   - `measure`: run-ops for `check-feasibility.mjs` / `check-distribution.mjs`
     (`--source {project}/spec/blueprint.json --report-out …` — already standalone-safe,
     script-location-relative REPO_ROOT) + gate-ops for schema/sentinel re-checks; trace-detector
     thresholds if non-default.
   - `judge`: `{{WORKSPACE}}/packages/skills/harden-blueprint/optimize-judge.md` (new file,
     instantiated from the piflow template; references criteria anchor
     `.agents/skill-system-criteria.md#harden-harden-blueprint` (line 55) + gold
     `eval/gold/platformer/mecha-plumber.blueprint.json` + GOLD-NOTE).
2. Extend `packages/verify/optimize/scope.mjs` copyScope for the gameplay editable scope.
3. **The demo (single full loop, the success criterion from the grilling):**
   `piflowctl optimize triage --node gameplay --topk 1` on tS2 → issue files appear (hard flags:
   the known 9–13s thinking blocks, cacheRead:0 waste, any measure-op findings; soft: judged vs
   criteria+gold) → `piflowctl issues --node gameplay` shows them → activate ONE:
   `piflowctl optimize fix --node gameplay --issue <name> --watch` → fixer edits candidate →
   child run `tS2.gameplay` re-runs the node → measure delta → staged → human adopt →
   commit lands with the trailer → attempts row carries {commit, verifiedByRun} →
   `piflowctl issues` shows `resolved/fixed`.

## 2 · Laws honored (cross-cutting)
- Shipped optimize code: imported, never moved/renamed; classic CLI grammar byte-compatible.
- Memory system untouched (no memorize/distill/compact edits; substrate never writes memory.md).
- SDK boundary: detectors are generic pi-event logic (core-legal); scripts/judge/gold/criteria/
  ledger live in the product; nothing product-specific enters `@piflow/core`.
- Oracle immutability: criteria fixture, gold, measure scripts are judging references — the fixer's
  candidate scope must NOT include them (copyScope excludes; the judge prompt states it).
- Candidate-copy discipline: live files touched only by adopt (backup-then-overwrite + commit).
- Config-with-defaults everywhere: thresholds, caps, model, topk, judge-on-verify — all overridable,
  none required in node.json for the block to be useful.
- Release hygiene: consumer-facing changes (schema block, CLI verbs, run-name default) each get a
  changeset; publish stays MAINTAIN-mode (docs/RELEASING.md).

## 3 · Order & effort
M0 → M1 → M2 (foundations, parallel-safe) → M3 → M4 → M5 → M6 → M7 (live).
Test-first per milestone; each lands as one `--no-ff` merge-able unit on this worktree branch.
Biggest risks (from recon): child-run workspace override for the candidate rerun (M6.3 — verify
`{{WORKSPACE}}` threading in runFromTemplate opts), agent-written drafts vs mechanical identity
(M4.3 boundary), and the run-name default swap's blast radius (M1.2 — audit callers of
`generateRunName` before swapping).

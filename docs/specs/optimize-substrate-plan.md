# Optimize Substrate — implementation plan

> The per-node optimization substrate: a SECOND optimization system beside the shipped routing loop
> (`piflowctl optimize <rundir>`), sharing its staging/adopt philosophy but replacing the programmatic
> one-defect-per-node triage with a measurement → issue-decomposition → per-issue-fix pipeline.
> Locked design contract: the 2026-07-05/06 grilling session. Research grounding:
> `docs/research/2026-07-05-per-node-optimization-substrate-sota.md` and
> `docs/research/2026-07-05-issue-ledger-schema-sota.md`. Seam recon: the 5-lane workflow of 2026-07-06.
> **Adversarially verified 2026-07-06** (3 skeptic lanes: recon-fidelity · contract-compliance ·
> demo-feasibility; 10 blocking + 11 minor findings — ALL folded in below, marked ⚡).
> Demo target: game-omni run `tS2`, node `gameplay`. The shipped optimize code is NOT moved or renamed.

## 0 · Shape of the whole

```
piflowctl optimize triage --node gameplay [--topk 3 | --run tS2]     # phase 1 only
piflowctl optimize fix    --node gameplay [--status open | --issue <name>] [--watch]
piflowctl optimize        --node gameplay [--topk 3 | --run tS2]     # both phases
piflowctl issues          --node gameplay [--status open] [--json]   # read-only query (top-level verb)
```

- ⚡ `--run <id>` pins triage to an exact run (reproducible demos); `--topk` is the recency scan.
- ⚡ Full-loop (bare `--node`) = triage, then fix EVERY issue of the node whose status is
  `open|regressed` after the triage pass, ordered severity-desc then firstSeen-asc, under the
  per-pass cap. Say nothing → full optimization (the locked default).
- Module: `packages/core/src/optimize/substrate/` — sibling files inside the existing optimize module.
  Imports shipped primitives (`evaluateGate`, `writeStagingManifest`, `adoptFile`, events pattern);
  never touches `memorize.ts` (memory system out of scope — confirmed self-contained, memorize.ts:61).
- Operator = the agent (triage/fixer agents drive the CLI); the human reads `issues` and runs adopt.

## 1 · Milestones

### M0 — `optimize` block on node.json (schema + scaffold mirror)
The anti-drift contract (node.schema.ts is `additionalProperties:false` at :20 — any unknown
top-level key fails the WHOLE template load, template/checks.ts:29):
1. `packages/core/src/workflow/template/schema/node.schema.ts` — add top-level `optimize`:
   ```json
   "optimize": { "type": "object", "additionalProperties": false, "properties": {
     "measure": { "type": "array", "items": { "$ref": "#/$defs/op" } },
     "judge":   { "type": "string" }
   }}
   ```
   `measure` reuses the EXISTING `$defs/op` shape (node.schema.ts:341) byte-for-byte (gate/run
   bodies are the meaningful ones post-run). `judge` = token-resolved path to the soft-judge file.
2. `packages/cli/src/scaffold.ts` `buildNode` — mirror emit block (only-when-authored, like
   `fusion` at scaffold.ts:369-380 ⚡corrected line).
3. Loader `toNodeIntent`: **skipped deliberately** — the block is optimizer-facing; consumers read
   `<templateDir>/nodes/<id>/node.json` directly via fs (precedent: memory.md / recurrence.ts:49).
4. Tests (red-bar first): template with `optimize` block loads clean; unknown key inside it rejected;
   scaffold round-trips through the real `loadTemplate` (scaffold.test.ts pattern, comment L11-12).

### M1 — Run identity: date-seq names, child runs, lineage fields
1. `packages/core/src/names/`: `generateDateSeqName(existing, now)` — `YYMMDD-NN`, zero-padded
   per-day counter, same `(existing, rng?) ⇒ string` collision contract as `generateRunName`
   (generator.ts:40-55); `now` injected for testability. `childRunName(parentId, nodeId, existing)`
   → `<parent>.<nodeId>` then `.<n>`. Base names dot-free (enforced at mint); dots = lineage-only.
   Dot-safety: audited safe at every parse site (recon Q3 table).
2. `run.ts:520` default generator swaps to date-seq — ⚡ a DELIBERATE global change (user-locked:
   agent-minted names must scale to hundreds of runs), NOT scoped to substrate runs. Update the
   now-stale prose contract at status.ts:209-215 (currently documents pie names) in the same
   commit. Pie names are reassigned to issue naming. **Consumer-facing → changeset.**
3. `RunStatus` (status.ts:209): add `parent?: string; spawnedBy?: { by: string; issue?: string;
   issueId?: string }` — additive-optional, threaded via `RunOptions` (runner.ts:65-75) into the
   `ctx.status` literal (runner.ts:451-478), same pattern as `promptId`.
4. `substrate/child-run.ts` — `spawnChildRun(parentRunDir, nodeId, { templateDir, spawnedBy, workspace? })`:
   - mint child id; `unpackRunDir(await packRunDir(parent, { exclude: ['.pi/journal.json'] }),
     childDir)` — `PackOpts.exclude` exists today (migrate.ts:92,55-67). No journal entry ⇒ the
     target node unconditionally RUNs (journal.ts:219-221); the skipped prefix is force-`reused`
     (runner.ts:543); the artifact preflight passes because the tree was copied (runner.ts:578-611).
   - ⚡ **Replay-from-node-start is CONSTRUCTED, not restored** (verified: no snapshot mechanism
     exists — checkpoint.ts is HITL-only; retry is fix-forward by design, retry.ts:107; seed has
     no force flag, seed.ts:108-123). The construction: reset exactly the node's resolved WRITE
     SCOPE (`sandbox.write = contract.owns` — the jail-enforced surface of everything the node
     touched, node-lifecycle.ts:281, write-disjointness per template/checks.ts:129-143) in the
     child copy, via a new small exported helper `resolveNodeWriteScope(node, ctx)` (the resolve
     is currently inlined in runNode, node-lifecycle.ts:203-204); ALSO clear the node's warm
     session `.pi-sessions/<nodeId>.jsonl` so the child starts a COLD conversation. Seed then
     re-stages naturally (`destFilled === false`, seed.ts:123), reconstructing the exact pre-node
     starting artifact. Provably sufficient AND provably safe — the reset surface is the node's
     own contract, not a guess.
   - ⚡ Window selection must be id-EXACT: `selectWindow`'s from/until is substring-match over
     phase/id/label (window.ts:6-13) — a general primitive can't ride that. `spawnChildRun`
     resolves the exact stage index for `nodeId` itself and passes a pinned window (no collision
     in game-omni today, but the primitive must not depend on luck).
   - `runFromTemplate(templateDir, { runDir: childDir, run: childId, from/until: <pinned>,
     parent, spawnedBy, workspace?, …provider/model carried from parent run.json })` —
     `opts.workspace` override exists today (entry.ts:165).
5. Tests: name generators (collision, padding, day rollover); spawnChildRun on a fixture template —
   child re-runs ONLY the target node, write-scope reset verified (owned paths regenerated, upstream
   artifacts untouched, session cold), run.json carries parent/spawnedBy.

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
  Hard-check issues: `sig` is mechanical (`<node>::<ruleId>::<normalized-location>`); judge issues:
  the triage agent authors a stable `sig` tag reusing game-omni's memory.md convention
  (`sig: <node>::<tag>`). Excluded from the hash: timestamps, run ids, line numbers, prose.
- **Dedup/reopen is two-layer:** agent semantic-match (reads the ledger first, writes into the
  matching file — primary) + tool hash equality (mechanical backstop / recurrence auto-linker).
- ⚡ **Status machine, fully wired** (contract lane found 3 orphan states):
  `open → active` (fix dispatch) `→ fix-landed` (candidate edit staged) `→ verifying` (prove-rerun
  in flight) `→ resolved` (adopt+commit; reason: fixed). Skip-proof path: `fix-landed → resolved`
  directly when proving is configured off. Reopen on hash re-match of a resolved issue sets
  `status: regressed` (distinct from fresh `open`) + stamps `regressedIn` on the last attempt +
  `lastSeen`. Fix selectors match `open|regressed` by default.
- API: parse/write/validate one issue file; `listIssues(templateDir, {node, status})`;
  `stampAttempt`, `reopen`, transition guards (invalid transition throws). All identity mutations
  mechanical (agent writes drafts; the tool computes id/name/firstSeen — M4).
- Tests: frontmatter round-trip; hash stability under title/prose/run changes; reopen-not-duplicate
  → regressed; attempts append-only; transition guards.

### M3 — Hard measurement stage (`substrate/measure.ts` + `substrate/trace-metrics.ts`)
Fully external to the runner — reuses the op READER + pure EXECUTORS; `node-lifecycle.ts` untouched:
1. Read the node's `optimize.measure` op[] directly off node.json; build a standalone `ResolveCtx`
   `{ run: runDir, workspace, state: JSON.parse(stateFile(runDir)) }` (resolver.ts:25; layout.ts:21);
   resolve with `resolveDeep`. (`{{arg.*}}` is not persisted post-run — documented unsupported.)
   ⚡ **`{{WORKSPACE}}` in measure ops ALWAYS resolves to the live product root, never a candidate**
   — scoring runs on the pristine oracle even when the node under test ran against a candidate
   workspace (see M6.3; this is what keeps the oracle immutable in practice).
2. Fire: `gatesFromOp(ops).post` → `evaluateChecks(checks, readFromRunDir)` (src/checks.ts:117 —
   ⚡ the top-level checks.ts, not template/checks.ts); `runOpsFromOp(ops).runnable` →
   `applyMergeOp({run}, runDir)` (merge.ts:58; the canonical pattern per node-lifecycle.ts:588).
   ⚡ Convention: measure ops write their outputs under `{{RUN}}/optimize/substrate/` (authored
   that way in the product) so measuring never clobbers the run's own report artifacts.
3. Built-in trace detectors (generic pi-event parsing, product-agnostic ⇒ core-legal), over
   `.pi/nodes/<id>/events.jsonl`. ⚡ Event shapes corrected per the live histogram:
   - `thinking_start/thinking_end` are NOT top-level events — they are
     `message_update.assistantMessageEvent.type` values; content rides the `thinking_end`
     sub-event; span = paired `_t` deltas on the enclosing `message_update` lines.
   - usage lives at `turn_end.message.usage.{input,output,cacheRead,…}` (not `turn_end.usage`).
   - ⚡ the log truncates records at a hard 8192-byte line boundary (20 such lines in tS2 — and
     they're exactly the big thinking/turn_end records). Detectors must skip-and-count
     unparseable lines and approximate spans from surrounding parseable events; the fixture
     suite includes a truncated-record case.
   - **thinking-stall**: span duration + content length vs thresholds.
   - **tool-loop**: group `tool_execution_*` by `(toolName, JSON.stringify(args))`; flag ≥N
     repeats with byte-identical results (handle the `truncated:true` result shape).
   - **token-waste**: cumulative input growth per turn; ⚡ the `cacheRead:0` cache-miss flag fires
     only when the provider/API reports cache fields at all (`api:'openai-completions'` never
     does — flag the capability, not every nebius run by construction).
   - fold `projectRunDigest(buildRunView(runDir).view)` anomalies — ⚡ `.view` destructure is
     load-bearing (buildRunView returns `{view, audit}`, runView.ts:407; score.ts:95-96 precedent).
4. Output: `<runDir>/optimize/substrate/measure.<node>.json` — one deterministic report,
   ⚡ carrying GRADED metrics (fillRatio, span ms, token totals, jump-margin numbers), not just
   pass/fail verdicts — the prove-gate compares on the graded axes (see M6.3 / the tS2 finding).
5. Tests: each detector against synthetic events.jsonl fixtures that FAIL when the detector is
   wrong (span too short → no flag; identical-args-different-results → no flag; truncated-line
   fixture); real-fs op firing with a fixture script; report determinism.

### M4 — Soft judge = the triage agent (`substrate/judge.ts` + `substrate/agent.ts`)
⚡ (module renamed from `triage.ts` — `optimize/triage.ts` already exists and is unrelated)
1. `substrate/agent.ts` — the ONE thin spawn wrapper (never hand-rolled `spawn('claude',…)`):
   builds a literal one-node `WorkflowSpec` (`executor:'claude-code'`) and calls `runFromConfig`
   (entry.ts:85) — credentials, model routing, sandbox jail, `parseClaudeResult`,
   `NodeStatusRecord` telemetry all inherited. ⚡ **Model selection speaks the SDK's own tier
   language, never a hardcoded model name**: substrate agent nodes carry `tier: 'balanced'` as
   the default (judge AND fixer), resolved through the normal `resolveClaudeModel` precedence
   (`node.model > tiers.claude[tier] > tiers.tiers[tier]`, model-routing.ts:136) off the user's
   `~/.piflow/model-tiers.json`. Default tier is `balanced`, NOT `deep` — deep maps to the
   documented won't-commit-edits fixer failure (memory: optimize-fixer-tier-finding; 6 runs,
   0 edits). Overridable per node/call/env like every other tier — changing the default is
   changing one word of config.
2. ⚡ The `optimize triage` CLI path RUNS M3's measure stage first (persisting
   `measure.<node>.json`), then spawns the judge — hard-feeds-soft is the verb's own contract,
   not an ambient assumption.
3. Judge flow per (node, run): assemble the prompt from the node's `optimize.judge` skill file +
   the measure report + criteria anchor + gold path + memory.md + the git-search instruction
   (`git log --grep '^skillsys(<node>)'` — the convention confirmed live in game-omni).
   ⚡ `readScope` must include the PRODUCT REPO ROOT (which covers `.git`) and `execCwd` = repo
   root — the seatbelt profile is deny-by-default (read-scope.sb) and an undeclared `.git` makes
   `git log` fail inside the jail. ⚡ The judge's history tooling is `git` ONLY (log/show/blame
   over the in-scope repo — no `gh`, no network archaeology); declared like any node tool,
   nothing bespoke. Writes stay jailed: `owns` = the node's `issues/` dir (+ the run's substrate
   dir). The agent: reads existing issues first (reopen-over-create), then writes issue DRAFTS
   (no id/name/firstSeen) or edits existing files' context/severity.
4. Post-process (mechanical, tool-side): validate every touched file; compute `id` from `sig`;
   mint pie `name`s; stamp firstSeen/lastSeen; hash-dedup backstop (draft colliding with an
   existing id → merged as a reopen). Cap: new-issues-per-pass limit (default 5).
5. Stamp the analyzed marker `<runDir>/optimize/substrate/triaged.<node>.json` ({when, issues[]}).
6. Separation law in the judge prompt: identify + contextualize ONLY — zero fix proposals.
   Criteria/gold are judging references, NEVER injected into the worker node's own prompt.
7. Authoring deliverables: the judge prompt TEMPLATE (piflow-side:
   `docs/design/substrate-judge-template.md`, structured per agentic-prompt-design) + game-omni's
   concrete judge file (product-side, M7).
8. Tests: post-processor (drafts → identity-stamped files; collision → reopen; cap enforced);
   prompt assembly (all inputs present, criteria anchor resolves). Agent behavior itself is
   proven by the M7 live demo (eval, not unit — test-discipline).

### M5 — CLI verbs (`packages/cli/src/issues.ts` + optimize dispatch)
1. Dispatch (cli.ts:335-345) — subverbs FIRST, then legacy flags, classic fallthrough unchanged:
   ```
   if (rest[0] === 'triage' && rest.includes('--node'))  → runSubstrateTriageCli(rest.slice(1))
   else if (rest[0] === 'fix' && rest.includes('--node')) → runSubstrateFixCli(rest.slice(1))
   else if (rest.includes('--rounds' | '--adopt' | '--fix'))  → classic paths (unchanged)
   else if (no positional && rest.includes('--node'))         → substrate full loop
   else                            → runOptimizeCli (classic <rundir>)
   ```
   ⚡ The `--node` requirement on subverbs closes the residual trap the contract lane found
   (a run literally named `triage`/`fix` invoked as `optimize triage` no longer misroutes —
   classic positional invocations never carry `--node` on the bare path). Classic `--node`
   (the `--fix`-path substring filter) keeps its existing meaning untouched.
2. Selection: `--run <id>` pins an exact run; else `--topk K` scans the product's runs home —
   runs where run.json shows this node executed fresh (`nodes[id].status` ok/error, not
   `reused`), ordered by startedAt, newest K lacking the triaged marker. Default K=1.
3. Top-level `issues` verb: registration copies the `blueprint` pattern (cli.ts:389-393 region +
   HELP; internal `list|show` sub-dispatch per blueprint.ts:109-116). `--json` for agents, table
   for humans. ⚡ Default sort: severity desc, then firstSeen asc — severity is CONSUMED here and
   in fix ordering, not write-only. Template dir resolved like optimize does (`templateDirFor`,
   optimize-fix.ts:172, or `--template`).
4. Tests: dispatch-routing unit tests (every row above, incl. `optimize fix --node` vs classic
   `optimize --fix <rundir>` vs a rundir literally named `fix`); arg parsers; issues list/show
   against a fixture ledger (sort order asserted).

### M6 — Fix phase (`substrate/fix.ts` + events + adopt-commit)
Per selected issue (severity-desc order; sequential for the demo — parallel is a later flag):
1. `status → active` on dispatch. Candidate copy = ⚡ **the node's full `{{WORKSPACE}}`-read
   closure** (its `contract.readScope` entries + every workspace path its hooks/ops reference —
   for gameplay that includes `templates/genres.json` and `.agents/node-catalog.json`, both
   proven runtime reads the draft scope missed), MINUS the oracle exclusions: any path referenced
   by `optimize.measure` ops, the `judge` file, criteria, gold. Exclusion is mechanical (derived
   from the same node.json block), enforced by copyScope; the fixer physically cannot edit the
   scorer.
2. Fixer agent via `substrate/agent.ts`: prompt = the issue FILE (the path is the whole dispatch
   contract) + fix contract; sandbox `execCwd = candidateRef` + `execReads` (the E10 seam,
   types.ts:245). `editsApplied` from the product's before/after diff (product-side,
   binding-live.mjs:56-79 precedent). On staged edit: `status → fix-landed`.
3. Prove (self-rewind; skippable per config — skip ⇒ `fix-landed → resolved` on adopt):
   `status → verifying`; `spawnChildRun(parentRunDir, nodeId, { workspace: candidateRef,
   spawnedBy: {by:'substrate-fix', issue} })` — the NODE executes against the candidate workspace,
   its own artifacts pre-deleted (M1.4) so it genuinely regenerates; then M3 measure runs on the
   child with `{{WORKSPACE}}` = the LIVE product root (pristine scripts score a candidate-produced
   artifact) → ⚡ delta compared on the GRADED axes (fillRatio, spans, tokens, margins — tS2's
   binary verdicts are already saturated at pass, so pass/fail deltas carry no signal) →
   `evaluateGate`-shaped strict-improvement decision (gate.ts:42 reused; unmeasurable/abstained ⇒
   stage-for-human, never auto).
4. Stage: substrate manifest (writeStagingManifest-shaped, per-issue records). **Adopt** (separate
   human verb, philosophy unchanged): `adoptFile` per real file (land.ts:92, symlink-safe walk)
   into the live product, then the NET-NEW `commitAdoption(repoRoot, files, issue)` —
   `execFileSync('git', ['-C', root, 'add'|'commit', …])` (worktree.ts:64 precedent; argv-array,
   so the trailer `Issue: <node>/<name> — "<title>" (<hash7>)` needs no escaping). SHA captured
   from the commit and stamped mechanically: `attempts += {commit, verifiedByRun: <childId>}`,
   `status → resolved, reason: fixed`.
5. `SubstrateEvent` union + own `safeEmit` copy (it's a private closure per module — driver.ts:170,
   loop.ts:88) + `renderSubstrateEvent`; CLI `--watch`/`--watch-json` reuse the optimize-fix.ts
   rendering split.
6. Tests: gate wiring; `commitAdoption` against a temp git-repo fixture (trailer format, SHA
   capture, no-op on empty diff); attempts stamping; the copyScope oracle-exclusion rule
   (a measure-script path inside the candidate ⇒ test fails); status transitions; event order.

### M7 — game-omni binding + the LIVE demo (the acceptance gate for the whole build)
Product-side contributions (all recorded in game-omni, per its conventions):
1. `nodes/gameplay/node.json` gains the `optimize` block:
   - `measure`: run-ops for `check-feasibility.mjs` / `check-distribution.mjs` with
     `--report-out {{RUN}}/optimize/substrate/…` (⚡ never clobbering the run's own reports) +
     a schema-compile gate; trace-detector thresholds if non-default.
   - `judge`: `{{WORKSPACE}}/packages/skills/harden-blueprint/optimize-judge.md` (instantiated
     from the piflow template; references the criteria anchor
     `.agents/skill-system-criteria.md#harden-harden-blueprint` (line 55) + gold
     `eval/gold/platformer/mecha-plumber.blueprint.json` + GOLD-NOTE).
2. ⚡ A NEW gameplay-scope module beside `packages/verify/optimize/scope.mjs` (not an extension —
   the existing copyScope/oracle are the built-game/milestone path, none of whose assumptions
   apply to the blueprint node).
3. ⚡ **Demo expectations, honestly set** (the feasibility lane's tS2 findings):
   - tS2's hard pass/fail axes are saturated (both reports `pass`, empty reasons) — the demo's
     issues will come from: the trace detectors (the real 9–13s thinking blocks), the SOFT judge
     (criteria + gold side-by-side), and one gift-wrapped hard finding the run itself recorded:
     `schemaSkipped: "schema unreadable/uncompilable"` — the blueprint schema gate silently never
     ran. That's a legitimate, provable first issue (fix → the child run's schema gate actually
     fires — a crisp graded→binary win). ⚡ A dedicated sub-agent task owns making that gate WORK
     (game-omni side, the schema-compile defect) — as the demo's first fixed issue if the loop
     drives it, or as pre-demo prep if it blocks authoring the measure ops; either way the gate
     and the hard/soft measure stages speak the exact same op[] syntax, one reader, no forks.
   - The prove-gate compares graded metrics, not the saturated verdicts.
4. **The demo (single full loop, the success criterion from the grilling):**
   `piflowctl optimize triage --node gameplay --run tS2` → measure report + issue files appear →
   `piflowctl issues --node gameplay` lists them (severity-sorted) → activate ONE:
   `piflowctl optimize fix --node gameplay --issue <name> --watch` → fixer edits candidate →
   child run `tS2.gameplay` re-runs the node (artifacts regenerated) → graded measure delta →
   staged → human adopt → commit lands with the trailer → attempts row carries
   {commit, verifiedByRun} → `piflowctl issues` shows `resolved/fixed`.

## 2 · Laws honored (cross-cutting)
- Shipped optimize code: imported, never moved/renamed; classic CLI grammar byte-compatible
  (⚡ one accepted narrow exception, documented: `optimize <rundir> --node …` forms; see M5.1).
- Memory system untouched (no memorize/distill/compact edits; substrate never writes memory.md).
- SDK boundary: detectors are generic pi-event logic (core-legal); scripts/judge/gold/criteria/
  ledger live in the product; nothing product-specific enters `@piflow/core`.
- Oracle immutability, mechanically enforced: measure runs on the live workspace (M3.1), copyScope
  excludes every scorer path (M6.1) — not a prompt-level promise.
- Candidate-copy discipline: live files touched only by adopt (backup-then-overwrite + commit).
- Config-with-defaults everywhere: thresholds, caps, model, topk, prove-on/off — all overridable,
  none required in node.json for the block to be useful.
- Release hygiene: consumer-facing changes (schema block, CLI verbs, run-name default) each get a
  changeset; publish stays MAINTAIN-mode (docs/RELEASING.md).

## 3 · Order & risks
M0 → M1 → M2 (foundations, parallel-safe) → M3 → M4 → M5 → M6 → M7 (live).
Test-first per milestone; each lands as one coherent commit on this worktree branch.
Remaining watch-items after verification: the child-run rerun cost/nondeterminism (Kimi temp≠0 —
single-replay deltas are noisy; the demo gates on graded axes and stages-for-human on ambiguity;
a paired-replay budget is the documented follow-up), and the judge agent's draft quality (proven
by the live demo, tunable via the template).

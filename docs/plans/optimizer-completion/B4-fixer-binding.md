# B4-fixer-binding — Real product-side fixer binding that lands a fix (game-omni)

- **Cluster:** B-big-rock
- **Effort:** large
- **Needs sign-off:** YES
- **Depends on:** A1-land
- **Shared-file risks:** packages/cli/test/fixtures/fake-binding.mjs (also touched by any test adding a fixer stub); .claude/skills/piflow-enhance/SKILL.md and .claude/skills/piflow-overlord/SKILL.md (A1-land also documents the adopt step here)
- **Files touched:** packages/verify/optimize/binding-live.mjs (game-omni repo — NEW, real fixer; path is the documented convention, confirm at execution) · packages/verify/optimize/scope.mjs (game-omni repo — NEW/existing copyScope the fixer's candidateRef points into) · packages/verify/optimize/fixer-prompt.mjs (game-omni repo — NEW, the deep-tier fix prompt template + budget/watchdog knobs) · packages/verify/optimize/binding-dry.mjs (game-omni repo — NEW, no-model dry binding for wiring tests) · packages/verify/optimize/test/binding-live.test.mjs (game-omni repo — NEW, the load-bearing spawn/budget/abort tests) · .claude/skills/piflow-enhance/SKILL.md (SDK worktree — refine the 'Authoring a product binding' section to match the shipped fixer, if drift found) · .claude/skills/piflow-overlord/SKILL.md (SDK worktree — confirm the GAME_OMNI_FIXER_* knob names match what ships)

**Open questions:**
- game-omni is NOT in this worktree — where does the binding physically live and how is it exercised? RECOMMENDED DEFAULT: it lives in the game-omni product repo at packages/verify/optimize/binding-live.mjs (the location BOTH .claude/skills/piflow-enhance/SKILL.md:124 and piflow-overlord/SKILL.md:94 already name as canonical). This B4 plan is therefore authored to be executed IN the game-omni repo, not this SDK worktree; the only SDK-worktree deliverable is a doc-drift refinement of the two skills if the shipped shape diverges. If the user wants the binding vendored into this repo instead, that VIOLATES the SDK boundary law (no product code in packages/) and must be a separate product-repo checkout — HALT and confirm the repo before writing binding-live.mjs.
- Which candidate scope does copyScope hand the fixer — a full worktree copy (fixer can rebuild + browser-verify in place) or the minimal owns/readScope set? RECOMMENDED DEFAULT: the minimal owns/readScope set + a rebuild step, matching the enhance-skill spec ('the minimal owns/readScope set + rebuild'); a full-worktree copy is the fallback only if the minimal set can't rebuild.
- Should the fixer's wall-clock/turn budget default be committed as a hard number or left env-only? RECOMMENDED DEFAULT: ship documented defaults (noEditToolBudget:22, depReadBudget:3, plus a wall-clock ceiling e.g. 12 min) as the cited-from-SWE-monitor baseline, ALL overridable via GAME_OMNI_FIXER_* — never a bare magic number in code without the env seam.

---
## B4 — Real product-side fixer binding that lands a fix (game-omni)

### 1. Objective & the exact symptom to close
Ship the FIRST real `fixer` stage for `piflowctl optimize --fix --binding <module>`: a context-isolated `claude -p` run on the **deep** model tier that reads a defect's two-leg scope-context, actually EDITS files in the candidate COPY, reports `editsApplied`, and enforces its **own** wall-clock / turn / no-progress budget — surfacing a cutoff as `CandidateEdit.aborted{reason}`. Today the only `fixer` impls in-repo are test stubs (`packages/cli/test/fixtures/fake-binding.mjs:6` returns a hardcoded `{editsApplied:1}`; `fake-loop-binding.mjs:24` identical) — there is NO real one.

**The handoff symptom to close** ("fixer traces roots but times out before editing") is, per the overlord worked example (`.claude/skills/piflow-overlord/SKILL.md:163-171`), the live M3 case: `fixer-started` → 40 `fixer-trace` tool-calls → `fixer-done edits=0` → `gated reject (no edit applied)`. The agent diagnosed for the whole budget and never committed. This is treated as a **prompt/budget-tuning problem**, exactly as the invariant frame demands — NOT a core change: the prompt must force an edit before the budget expires, and the watchdog must abort the diagnose-forever spiral early with a portable reason.

### 2. Why this is a PRODUCT task riding the CLI binding (invariant map)
- **Model PROPOSES + SCORES; code DECIDES/BOUNDS/LANDS.** The fixer only proposes edits to a candidate copy; `runFixGate` (`packages/core/src/optimize/driver.ts:124`) still scores via the injected `replayScore`, decides via `evaluateGate`, and lands nothing. B4 adds intelligence ONLY in the injected `fixer` stage — core is untouched.
- **The loop never mutates a live file.** The fixer writes ONLY to `ctx.candidateRef` (the copy `prepareCandidate`/`copyScope` returns; `driver.ts:166`, `replay.ts` `prepareCandidate = copyScope(defect.node)`). Physical landing stays the separate `land.ts` adopt step (A1). B4 must NEVER let the fixer touch the live template/source.
- **SDK boundary law.** `@piflow/core` is product-agnostic (no model, no network, no `claude -p`). The binding is dynamic-imported product code (`packages/cli/src/optimize-fix.ts:86 loadBinding`, `:216`); it belongs in the **game-omni product repo** (`packages/verify/optimize/binding-live.mjs`), the location both `.claude/skills/piflow-enhance/SKILL.md:124` and `piflow-overlord/SKILL.md:94` already name. It rides the CLI seam; it is NOT in this worktree's `packages/`.
- **Pointer + resolve-at-read.** B4 CONSUMES the already-wired `scope.codeMap` — `scoreTriageEnrich` (`optimize-fix.ts:130`) already dereferences each SKILL lesson's `[[okf-slice]]` into `scope.codeMap` via `enrichCodeMap`+`resolveSlice` BEFORE the fixer runs. The fixer reads `defect.scope` (recurrence/root/prevention/codeMap; `types.ts:110 DefectScope`); it MUST NOT re-embed or re-fetch a slice copy.
- **Core enforces NO fixer timeout.** Confirmed: grep shows no wall-clock/deadline/kill/watchdog in the core fix path; `runFixGate` awaits `stages.fixer(...)` unbounded (`driver.ts:169`). `CandidateEdit.aborted` (`driver.ts:31`) is PRODUCT-reported and only re-emitted as the `fixer-aborted` event (`driver.ts:173`). Therefore the entire budget/watchdog/kill is B4's job, inside the binding.

### 3. The contract the binding fulfills (grounded in the real types)
The `fixer` type (`driver.ts:39`): `(defect: Defect, ctx: { candidateRef: string; emit?: (payload) => void }) => Promise<CandidateEdit>`.
- **Input `defect`** (`types.ts:131`): `node`, `bucket` (`'LAPSE'|'SKILL'|'FUNCTIONALITY'|'ARCH'`), `symptom`, `evidence[]`, `confidence`, optional `scope` (`recurrence`, `root`, `prevention`, `okfSlice`, `codeMap[]`).
- **Input `ctx.candidateRef`** = the candidate copy dir (from `copyScope`); the fixer edits HERE only.
- **Input `ctx.emit`** = opaque sub-trace channel; core re-emits verbatim as `fixer-trace` (`driver.ts:169`, `events.ts` `fixer-trace`). The watchdog reason MUST also ride here as `payload = {type:'watchdog_abort', reason, …}` (documented in `piflow-overlord/SKILL.md:69`).
- **Output `CandidateEdit`** (`driver.ts:18`): `editsApplied` (0 = no-op the gate rejects), optional `candidatePassedProductChecks` (did the candidate pass the product's own build/tests — feeds the stricter gate at `driver.ts:186`), `tokensSpent`, `summary`, and `aborted?: { reason: string }` (set when cut short; still just a 0-edit proposal the gate judges — `driver.ts:172`).

**Bucket-conditional behavior** (per `types.ts:10-15`): LAPSE → the skill was right, executor slipped (usually re-run guidance, minimal edit); SKILL → edit the prose envelope (`prompt.md`/`SKILL.md`/`node.json`) in the candidate; FUNCTIONALITY → edit product CODE in `owns`/`readScope`; ARCH → route UP (do NOT attempt; return `editsApplied:0` + a summary flagging it escapes node scope). The prompt template selects instructions by `defect.bucket`.

### 4. Design — the three binding modules (all game-omni repo)
Mirror the documented layout (`piflow-enhance/SKILL.md:122-125`): `scope.mjs` (copyScope), `binding-live.mjs` (live oracle+fixer), `binding-dry.mjs` (no-model dry binding). B4 authors the **fixer** in `binding-live.mjs` + a `fixer-prompt.mjs` helper; `oracle`/`copyScope` are the sibling stages (oracle may pre-exist from the replay work — confirm; if absent, it is out of B4's scope beyond a stub the fixer's `candidatePassedProductChecks` can call).

**4a. The spawn (mirror the proven `claude-code` executor, do NOT reuse it).** The node-runtime executor (`packages/core/src/runner/command.ts:127 claudeCommand`, `claude-executor.ts`) is the NODE executor and is UNRELATED to the optimizer fixer — but it is the PATTERN to copy:
- Invocation: `claude -p --permission-mode bypassPermissions --output-format stream-json --verbose --model <deep>` with the prompt on **stdin** (`command.ts:145` — Claude `-p` has no `@file`).
- Model: the **deep** tier from `~/.piflow/model-tiers.json` (product reads it directly; CLI exposes no reusable resolver — `packages/cli/src/model.ts` only has `applyModelCommand`, so the binding reads the JSON itself, per `piflow-enhance/SKILL.md:118` "the deep tier … the strongest model authors the fix").
- Credential: the binding runs on the local Max subscription; it may reuse the `resolveClaudeOAuthToken` pattern (`claude-executor.ts:100`) OR simply inherit the ambient logged-in `claude` (the binding is NOT jailed — it runs host-side in the optimizer process, unlike the node executor which is jailed). RECOMMENDED: inherit ambient login (no keychain injection needed off the critical path); document that `claude /login` is the prerequisite.
- Working dir: spawn with `cwd = ctx.candidateRef` so edits land in the copy; pass `--add-dir`/tool scope so the agent cannot escape the candidate.
- Parse the result with the SAME `parseClaudeResult` shape (`claude-result.ts:24` — `ok`, `subtype` e.g. `error_max_turns`, `numTurns`, `cost.inputTokens/outputTokens`). `error_max_turns` maps to an `aborted` reason.

**4b. `editsApplied` — MEASURED, never claimed.** The overlord law is "verify against the diff, not the self-report" (`piflow-overlord/SKILL.md:134`). So the binding computes `editsApplied` from a REAL diff of the candidate dir (git status/diff on the copy, or a before/after file-hash set), NOT from the agent's prose. A fixer that says "I fixed it" with 0 changed files returns `editsApplied:0`. This is the single most important anti-reward-hack property.

**4c. The wall-clock / turn / no-progress budget (B4's core new logic — core enforces none).** Implement the in-node behavioural watchdog documented at `piflow-overlord/SKILL.md:92-101`, tuned via `GAME_OMNI_FIXER_*`:
- **`no-progress`** — N tool-calls with 0 file edits (default `noEditToolBudget:22`, the cited SWE-monitor stagnation default arXiv 2512.02393; the M3 case tripped 40). SIGTERM the child, return `aborted:{reason:'no-progress: N tool calls / 0 edits'}`.
- **`dep-rabbit-hole`** — N `node_modules` reads (default `depReadBudget:3`); abort → `aborted:{reason:'dep-rabbit-hole'}`.
- **`repro-probe`** — a `node -e` repro loop; abort → `aborted:{reason:'repro-probe'}`.
- **wall-clock ceiling** — a hard SIGTERM→SIGKILL deadline (default ~12 min, `GAME_OMNI_FIXER_WALLCLOCK_MS`) so a hung child can never wedge the loop.
The watchdog tails the `stream-json` NDJSON (each `tool_use` / `result` / `rate_limit_event`) to count tool-calls-since-last-edit; on trip it kills the child AND emits `ctx.emit({type:'watchdog_abort', reason, …})` (opaque trace) AND returns `aborted:{reason}` (the typed, portable signal `driver.ts:173` re-emits as `fixer-aborted`). Note: an aborted fixer is STILL a proposal — if it managed ≥1 edit before the trip, return the real `editsApplied` so the gate can still accept a partial win.

**4d. The prompt (`fixer-prompt.mjs`) — the tuning that closes the symptom.** Per the invariant "address 'traces roots but times out before editing' as a prompt/budget-tuning problem". BEFORE authoring this prompt, INVOKE the `agentic-prompt-design` skill (it is a prompt an executor follows). The prompt must:
- State the bar: "You EDIT the candidate copy to make the failing check pass. Diagnosis without an edit is a FAILURE. Commit an edit early; you may refine after."
- Inject the grounding: `defect.symptom`, `defect.evidence`, and — for SKILL defects — `scope.root`/`scope.prevention`/`scope.codeMap[].body` (the resolved OKF slice, already inlined by `scoreTriageEnrich`; the fixer reads `defect.scope`, never re-fetches).
- Include the `consoleErrors` when present (`Tier1Result.consoleErrors`, `types.ts:57` — "the DOMINATING signal when a crash wedges the run loop"; surfaced into evidence).
- Forbid touching the oracle/verify harness/criteria fixture (reward-hack guard, `piflow-enhance/SKILL.md` ANTI-AD-HOC rules).
- Bucket-branch the instruction (§3). NEVER inject the criteria fixture (`piflow-enhance/SKILL.md`: "injecting the bar teaches-to-the-test").

### 5. Coordination with A1-land (dependsOn)
A1-land makes the physical adopt real (`land.ts` backup-then-overwrite). B4 produces the candidate the manifest points at; A1 lands it. The couplings: (i) A1 and B4 both concern "actually editing/landing files" — but they are DISJOINT surfaces: B4 edits ONLY the candidate copy; A1 adopts the copy→live. B4 must NOT pre-empt A1 by writing live. (ii) Both may edit the two skills' docs (the adopt step + the binding-authoring section) — coordinate the doc edits to avoid a conflict. (iii) B4 depends on A1 for the END-TO-END "lands a fix" claim: without A1's adopt, B4 can only STAGE. So B4 is verifiable standalone up to `landed:'staged'`; the full "lands a fix (game-omni)" acceptance needs A1 merged. Marked `dependsOn:['A1-land']`.

### 6. Test-first plan (test-discipline skill — INVOKE before writing any test)
The binding is external-API glue (spawns `claude`), so the load-bearing tests use a FAKE spawn seam (inject the child-process runner), never a real `claude` call in CI. The live path is validated by a real `piflowctl optimize --fix … --node m3 --watch` run (per `piflow-enhance/SKILL.md` "validated by a real run, not CI"), reported as evidence — NOT gated in CI.

**LOAD-BEARING TEST (the one that must FAIL when the code is wrong):**
> *"editsApplied is derived from the real candidate diff, not the agent's claim."*
> Arrange: a fake spawn that emits a `stream-json` stdout whose final `result` says success ("I fixed it") but writes ZERO files into `candidateRef`. Act: call `fixer(defect, {candidateRef})`. Assert: `editsApplied === 0` (and the gate would therefore reject).

**Test-the-test mutation (concrete):** change the binding to `editsApplied = result.ok ? 1 : 0` (trust the agent's success line instead of diffing the candidate). The test MUST turn RED (it would now assert `0` but get `1`). If the test still passes under that mutation, it is asserting nothing real — reject it. This directly guards the reward-hack the overlord skill's S1 eval scenario names (`s1-fixer-zero-edits-claims-success.md`).

**Second load-bearing test — the budget/abort:**
> Arrange a fake spawn emitting `noEditToolBudget+1` `tool_use` events and 0 edits. Assert: the watchdog SIGTERMs the child, and the return is `aborted:{reason: /no-progress/}` with `editsApplied:0`.
> **Mutation:** raise the watchdog threshold to `Infinity` → the test must RED (no abort fires, the promise would hang/return non-aborted). This proves the budget is actually enforced (closing the "times out before editing" symptom by aborting early).

**Third test — partial-edit-before-abort:** a fake spawn that writes 1 file THEN spins on tool-calls → assert `editsApplied:1` AND `aborted` set (an aborted fixer with a real edit is still a proposal the gate can accept).

**Fourth test — scope isolation (safety):** assert the fixer writes NOTHING outside `candidateRef` (the loop-never-mutates-live invariant). Point `candidateRef` at a temp dir, snapshot a sentinel "live" dir before/after, assert the live dir is byte-identical.

Do NOT over-hardcode: never assert the exact prompt string (unobservable intent); assert the OBSERVABLE contract (edits diffed, abort reason shape, no live write). The dry binding (`binding-dry.mjs`) is the no-model fixture for wiring tests that must not spawn.

### 7. Step sequence for the executor
1. Confirm the repo: this plan executes in the **game-omni** product repo, not this SDK worktree (Open Question 1). If game-omni is unavailable, HALT and surface it — do NOT vendor product code into `packages/`.
2. INVOKE `test-discipline` and `agentic-prompt-design` skills.
3. Write `binding-dry.mjs` (no-model dry fixer) + the four load-bearing tests FIRST; run them RED.
4. Author `fixer-prompt.mjs` (bucket-branched, scope-injecting, edit-forcing).
5. Author the fixer in `binding-live.mjs`: spawn `claude -p` deep-tier into `cwd=candidateRef`, tail `stream-json`, diff for `editsApplied`, enforce the `GAME_OMNI_FIXER_*` watchdog, return `CandidateEdit` with `aborted` on any trip.
6. Run the tests GREEN; run the abort mutation + the trust-the-claim mutation to prove the tests bite.
7. LIVE validation (evidence, not CI): `piflowctl optimize --fix <rundir> --binding packages/verify/optimize/binding-live.mjs --node m3 --watch --edit-budget 1` on a real failing run; verify the candidate `report.M3.json` flips `passed:false→true` and the gate records ACCEPT → `landed:'staged'`. Report the `--watch` stream + the candidate report as evidence, never the fixer's prose.
8. If the two SDK-worktree skills drifted from what shipped (knob names, module paths), refine `.claude/skills/piflow-enhance/SKILL.md` + `piflow-overlord/SKILL.md` — coordinate with A1's doc edits.

### 8. Anti-drift / non-goals (scope fence)
- Do NOT modify `@piflow/core` (no core change is needed — the seam already exists; `aborted`, `emit`, `candidateRef` are all present).
- Do NOT implement a wall-clock timeout in core (invariant: core enforces none, by design).
- Do NOT land live from the fixer (A1's job).
- Do NOT make this multi-candidate/Pareto (that is B1).
- Do NOT touch the `run` stage (B3/loop) — the single-shot `--fix` path never calls `run` (`optimize-fix.ts:28`).

### 9. Definition of done (observable)
- The four load-bearing tests pass; each fails under its named mutation.
- A live `--fix --node m3` run flips a real failing milestone to ACCEPT and stages (with A1 merged: adopts) — verified against the candidate report + gate verdict, not the agent's summary.
- The watchdog aborts a diagnose-forever run with a portable `fixer-aborted` reason before the wall-clock ceiling (closing the M3 symptom).
- No live file is mutated by the fixer (scope-isolation test green).

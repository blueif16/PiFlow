# A3-compact — Wire the cap/retire compaction pass (+ retire-trigger injectors)

- **Cluster:** A-loop-tail
- **Effort:** medium
- **Needs sign-off:** no
- **Depends on:** A5-understand, A1-land
- **Shared-file risks:** packages/core/src/optimize/memorize.ts: comment-only edit at line 96 removing the cap/retire TODO — low conflict risk, but A2-distiller also touches memorize-adjacent distill wiring; if A2 edits memorize.ts coordinate the single-line comment change
- **Files touched:** packages/cli/src/memory-compact.ts · packages/cli/src/scaffold.ts · packages/cli/src/cli.ts · packages/cli/test/memory-compact.test.ts · packages/core/src/optimize/memorize.ts

**Open questions:**
- O1 — Should `piflowctl memory compact` default to dry-run? RECOMMENDED DEFAULT: yes — dry-run reports the retire plan and writes nothing; require explicit `--apply` to mutate memory.md (protects a first-run operator; symmetric with land/adopt being a separate explicit step).
- O2 — How does a sig map to a graduation commit? RECOMMENDED DEFAULT: exact sig-in-commit-message (a `skillsys(<node>)`/`flowCommit` body literally contains `<node>::<key>`), which requires the land/MEMORIZE commit template (owned by A1-land) to echo the sig. Until A1 emits it, `graduated` is safely empty. The coarser node-level heuristic is rejected (over-retires).
- O3 — Coordinate with A5-understand: if A5 adds a machine-readable (`--json`) health status to the OKF `--check` gate, the codeShifted injector should consume that (one call over all keys) instead of the per-key exit-code probe. RECOMMENDED DEFAULT: ship the exit-code-per-key probe now (fully functional against today's `_generate.mjs`); switch to `--json` if/when A5 lands it.

---

# A3-compact — Wire the cap/retire compaction pass (+ retire-trigger injectors)

## 1. Problem & Goal

`compactMemory` (`packages/core/src/optimize/compact.ts:67`) is built, unit-tested (`packages/core/test/optimize-compact.test.ts`), and re-exported from the package root (`packages/core/src/optimize/index.ts:21`) — but has **ZERO live caller**. Every per-node `memory.md` grows unbounded as MEMORIZE appends lessons; `memorize.ts:96` carries the explicit TODO: *"cap/retire (memory-slices MODE B) — compaction is a SEPARATE out-of-band pass; NOT in the MVP."*

Two of the three retire triggers are also inert. `compact.ts:38-41`:
- `graduated` — sigs whose fix graduated to code/git (superseded). **INJECTED; no injector built.**
- `codeShifted` — sigs whose linked `[[okf-slice]]` went HEALTH-stale on the OKF `--check` gate. **INJECTED; no injector built.**

Only `cap-eviction` can fire today (it needs no injected input), so nothing exercises the unconditional-retire path in production.

**Goal:** (a) give compaction an out-of-band home so a human/operator can run it; (b) build the two deterministic retire-trigger injectors, both product/CLI-side (they shell to `git` and to the OKF `--check` engine — network/subprocess/product knowledge that MUST NOT enter `@piflow/core`); (c) wire them into the compaction verb.

## 2. Invariant audit (which invariant each choice honors)

- **Model PROPOSES / code DECIDES-BOUNDS-LANDS, all intelligence in injected stages, core is thin.** Honored: `compactMemory` stays pure fs + arithmetic (it already is — no change to its body). The two injectors are DETERMINISTIC (git log, `--check` exit code) — **no model call anywhere in this task**. They are computed CLI-side and passed as the already-existing `graduated`/`codeShifted` `ReadonlySet<string>` inputs.
- **The multi-round LOOP never mutates a live file; landing is explicit + out-of-loop.** Honored: compaction PHYSICALLY REWRITES `memory.md` (`compact.ts:120` `writeFileSync`), so it is an **out-of-band verb** (`piflowctl memory compact <dir>`), NOT a per-round loop hook. Justification vs. a loop hook is in §3.
- **SDK boundary law: `@piflow/core` is product-agnostic; product stages ride the CLI binding.** Honored: `compactMemory` is core (product-agnostic — takes injected sets); the two injectors (`git` history, the repo-local `_generate.mjs` OKF gate) are **CLI-side** in a new `packages/cli/src/memory-compact.ts`, exactly mirroring how `understand.ts` shells to `_generate.mjs` and how `optimize-fix.ts` dynamic-imports the product binding.
- **Pointer + resolve-at-read for the two legs.** Honored + REUSED: the `codeShifted` injector reads each lesson's `[[okf-slice]]` pointer via `deriveRecurrence` (which already parses `[[…]]` into `lesson.okfSlice`, `recurrence.ts:122`) and resolves it against the LIVE OKF `--check` gate — never a stored copy of drift state. This is precisely the skill's "the memory drift gate RIDES the OKF gate through the link" (memory-slices SKILL.md:143).
- **test-first + mutation-verified, no over-hardcoding.** Honored: §6 defines the load-bearing test (an injector correctly derives its retire set) BEFORE the injector, with a concrete test-the-test mutation.

## 3. Design decision: out-of-band VERB, not a loop hook (justified)

**Chosen home: a new CLI sub-verb `piflowctl memory compact <templateDir> [flags]`.** Rationale, each tied to an invariant:

1. **Loop-never-mutates-a-live-file.** `runOptimizeLoop` (`loop.ts:80`) is documented to never mutate a live file; landing a fix is already an explicit out-of-loop step (`land.ts` header). Compaction rewrites `memory.md` in place (`compact.ts:120`). Putting it inside the loop would make a physical mutation an implicit side-effect of *running* the loop — a direct invariant violation. An out-of-band verb keeps the mutation explicit + opt-in, symmetric with how adopt/land is a separate step.
2. **Cadence mismatch.** memory-slices SKILL.md:140 says compaction runs *"when over cap, out-of-band"* — a low-frequency maintenance sweep, not a per-round action. Per-round it would thrash (a lesson appended this round should not be evicted next round before its recurrence stabilizes).
3. **The injectors are expensive + product-coupled.** `graduated` shells `git log`; `codeShifted` shells the OKF `--check` engine per linked slice. Running these every round burns wall-clock and couples the core loop to git/OKF presence. As a verb they run on demand.
4. **Boundary law.** The injectors live product/CLI-side. A loop hook in core would either pull them into core (illegal) or force the loop signature to grow an injected `compact` stage — net complexity for a maintenance action that is genuinely off the critical path.

**Home of the verb code:** extend the existing `runMemoryCli` dispatcher in `packages/cli/src/scaffold.ts:822` (which already dispatches `memory scaffold`) to add a `compact` action, delegating to a new `packages/cli/src/memory-compact.ts` (keeps `scaffold.ts` from growing another concern — one file = one idea). This mirrors how `cli.ts` already routes `memory` to `runMemoryCli`; no new top-level verb, no `cli.ts` HELP restructure beyond one added line under `MEMORY`.

**Open question O1 (recorded, default chosen): should the verb default to a DRY-RUN?** Default = **dry-run OFF is dangerous for a first-run operator**, so the verb **defaults to `--dry-run` (report the retire plan, write nothing)** and requires an explicit `--apply` to mutate. Recommended default captured; user can overrule.

## 4. The two retire-trigger injectors (both deterministic, CLI-side)

Both live in `packages/cli/src/memory-compact.ts`. Each takes the templateDir + the set of node ids + the per-node lesson blocks (sig → `[[okf-slice]]`, obtained by reusing `deriveRecurrence`) and returns a `ReadonlySet<string>` of sigs, exactly the shape `CompactOpts.graduated` / `CompactOpts.codeShifted` want (`compact.ts:39-41`).

### 4a. `codeShifted` injector — RIDES the OKF `--check` gate (coordinate with A5-understand)

The signal (memory-slices SKILL.md:141-143, `compact.ts:40`): a lesson whose `[[okf-slice]]` went **HEALTH-flagged** on `understand --check` is code-shifted — the code its prevention guards moved, so the lesson may no longer apply.

**Mechanism (reuse, don't reinvent):**
1. Reuse the exported `resolveTopicsDir(startDir)` (`understand.ts:117`) to find `.agents/okf/topics`. If `null`, there is no OKF substrate → `codeShifted = ∅` (degrade silently, never throw — same posture as `enrichCodeMap`/`scoreTriageEnrich` in `optimize-fix.ts:148`).
2. Build the sig → okfSlice map by calling `deriveRecurrence({ templateDir, nodes })` (`recurrence.ts:49`) and reading `hit.lesson?.okfSlice` for each sig. This is the ONLY correct source: `deriveRecurrence` already parses `[[…]]` into `lesson.okfSlice` (`recurrence.ts:122`); `compact.ts`'s own `readBlock` does NOT read the link, so we must not try to get it from `compactMemory`.
3. Collect the DISTINCT set of linked slice keys. For each key, run the OKF gate scoped to that one key via the same engine `understand.ts` shells to: `execFileSync('node', [join(topicsDir,'_generate.mjs'), '--check', <key>], { cwd: topicsDir })`. Confirmed in `_generate.mjs`: `--check <key>` runs the HEALTH pass over just that card and `process.exit(1)` iff a HEALTH failure fired (an anchor/seed moved), exit 0 otherwise; DRIFT (stale auto-region) is advisory/non-blocking and does NOT exit 1 (`_generate.mjs:319-323`). So **exit code 1 for a key = that slice is HEALTH-stale = code-shifted**; exit 0 = fresh. Use `execFileSync` and read the thrown error's `.status` (as `understand.ts:159` `defaultRunGate` already does) — do not scrape stdout.
4. Any sig whose okfSlice key is HEALTH-stale → add sig to `codeShifted`.

**Injection so tests never shell:** the injector takes a `runCheck?: (topicsDir: string, key: string) => boolean` dep (default = the `execFileSync`-and-read-`.status` implementation, mirroring `understand.ts`'s `deps.runGate` seam at line 180). Tests inject a fake `runCheck` that flags a chosen key.

**Coordinate with A5-understand:** A5 may change the shape/exit-contract or add a machine-readable (`--json`) mode to the OKF `--check` gate. If A5 lands a per-key JSON health status, this injector should consume THAT instead of the exit-code probe (one `--check --json` call over all keys beats N per-key subprocess spawns). **DependsOn A5 for the gate contract**; the fallback (exit-code-per-key) is fully functional if A5 does not add JSON. Flagged in dependsOn + openQuestions.

### 4b. `graduated` injector — derived from git history

The signal (memory-slices SKILL.md:108, `compact.ts:39`): a lesson whose fix **graduated to code/git** (a `skillsys(<node>)`/`flowCommit` commit landed the durable guard, so the lesson is superseded — the fix is now in the code, not just a note).

**Mechanism (deterministic git query):** memory-slices SKILL.md:98 pins the convention — *"Every landed edit is a `skillsys(<node>)`/`flowCommit` commit whose message IS the record."* So graduation is observable in `git log`:
- For each node id with lessons, query `git -C <repoRoot> log --grep '^skillsys(<node>)' --grep '^flowCommit' -F --format=%H%x00%B` (or two calls; `--all-match` NOT wanted — either prefix graduates). Determine `<repoRoot>` from `templateDir` by walking up to the `.git` dir (reuse the same up-walk shape `resolveTopicsDir` uses; a helper `findRepoRoot(startDir)`).
- **Which sig graduated?** A graduation commit's body carries the lesson it closed. Two grounded options, pick the CONSERVATIVE one (Open Question O2):
  - **(default, chosen) sig-in-message:** a sig graduates iff a `skillsys`/`flowCommit` commit body literally contains the block's `sig:` string (`<node>::<key>`). This is exact, false-positive-free, and requires the commit author (the fixer/land step, cluster A1) to echo the sig in the message — a cheap convention we ADD to the land/MEMORIZE commit template. Until A1 emits the sig, `graduated` is simply `∅` (safe: nothing wrongly retired).
  - (rejected as default) node-level heuristic: "node has ANY skillsys commit since the lesson was appended" — too coarse (retires unrelated lessons on the same node).
- If `git` is absent or the repo has no `.git`, `graduated = ∅` (degrade silently).

**Injection so tests never shell:** the injector takes a `readGraduatedSigs?: (repoRoot: string, nodes: string[]) => Set<string>` dep (default = the `git log` implementation). Tests inject a fake returning a chosen sig.

**Coordinate with A1-land (dependsOn):** the sig-in-message convention must be emitted by whatever lands the fix commit (A1). This task OWNS the reader; A1 (or the land commit template) must OWN the writer. If A1 has not shipped, this injector is inert-but-safe. Flagged.

## 5. Wiring: `piflowctl memory compact <templateDir>`

New file `packages/cli/src/memory-compact.ts`, exporting `runMemoryCompactCli(argv, deps?)`. Flow:

1. **Parse args:** positional `<templateDir>`; `--node <substr>` (scope to matching nodes, mirroring `optimize-fix.ts:75`); `--max-lessons <n>` (override `DEFAULT_MAX_LESSONS`, `compact.ts:33`); `--apply` (default off = dry-run per O1); `--no-graduated` / `--no-code-shifted` (disable an injector — useful when git/OKF absent or noisy); `--json` (machine output).
2. **Discover nodes:** list `<templateDir>/nodes/*` dirs (reuse the same `readdirSync` shape as `recurrence.ts:60` `discoverNodes`, or call `deriveRecurrence` with no `nodes` to discover). Apply `--node` filter.
3. **Compute injected sets** (unless disabled): `graduated = graduatedInjector(templateDir, nodes, deps)`, `codeShifted = codeShiftedInjector(templateDir, nodes, deps)`. Both degrade to `∅` on any error, printed as a one-line stderr note ("graduated: git unavailable, skipping") — never abort the whole verb.
4. **For each node's `memory.md`** (`join(templateDir,'nodes',node,'memory.md')`): call `compactMemory(file, { maxLessons, graduated, codeShifted })` from `@piflow/core`. **DRY-RUN vs APPLY:** `compactMemory` writes unconditionally when something retires. For dry-run, DO NOT call it against the live file — instead copy each `memory.md` to a scratch temp path, run `compactMemory` on the copy, and report the returned `RetiredLesson[]` / `keptSigs` **without touching the live file** (the copy is discarded). Only `--apply` runs `compactMemory` on the live file. (This preserves "no implicit mutation": a bare `memory compact` mutates nothing.)
5. **Report:** per node, print retired sigs + reasons (`res.retired`) and kept count; a rollup line `compact: retired N lesson(s) across M node(s) (X graduated, Y code-shifted, Z cap-eviction)`. `--json` emits `{ node, file, retired, keptSigs }[]`. Dry-run prints the same with a `(dry-run — nothing written; pass --apply to compact)` banner.
6. **Dispatch:** in `scaffold.ts` `runMemoryCli` (`scaffold.ts:822`), add `case`/branch: `if (action === 'compact') return runMemoryCompactCli(rest)`. Add the `import`. Add one HELP line under the `MEMORY` block in `cli.ts` (`cli.ts:135`) — `compact <templateDir> [--apply] [--node <s>] [--max-lessons n]  retire graduated/code-shifted/over-cap lessons (dry-run unless --apply)`.

## 6. Test-first plan (load-bearing test + test-the-test)

**Test file:** `packages/cli/test/memory-compact.test.ts` (new; CLI-side, since the injectors + verb are CLI-side). `@piflow/core`'s `compactMemory` already has full unit coverage (`optimize-compact.test.ts`) — do NOT duplicate it; test the NET-NEW seam: the injectors + the dry-run/apply gating.

**Load-bearing test A — `codeShifted` injector derives the retire set from the OKF gate through the `[[okf-slice]]` link.**
Arrange a scratch templateDir with two nodes; node `flaky` has a lesson block linking `[[runner]]` and another linking `[[observe]]`. Inject a fake `runCheck` that returns HEALTH-stale (true) for `runner` only. Assert the injector returns `Set { 'flaky::<runnerKey>' }` and NOT the `observe`-linked sig. This asserts the OBSERVABLE contract: the sig whose linked slice is stale is retired, riding the gate through the pointer — exactly memory-slices SKILL.md:143.
- **Test-the-test mutation:** change the injector to key `codeShifted` off the node id instead of the sig's `[[okf-slice]]` link (i.e. flag every sig on a node that has ANY stale slice) → the `observe`-linked sig would wrongly enter the set → the test FAILS. Also: invert the `runCheck` boolean (treat exit-1 as fresh) → the stale sig is missing → FAILS. Both prove the test is not vacuous.

**Load-bearing test B — `graduated` injector reads the sig out of a `skillsys`/`flowCommit` commit body.**
Inject a fake `readGraduatedSigs` returning `Set{'flaky::alpha'}`; feed a memory.md with blocks `flaky::alpha` (recurrence 5, under cap) and `flaky::beta`. Run the verb with `--apply`, `--max-lessons 8` (no cap pressure). Assert `alpha` is retired with reason `graduated` and `beta` survives. This proves the injector's set flows into `CompactOpts.graduated` and drives an UNCONDITIONAL retire under the cap (the path cap-eviction can't reach).
- **Test-the-test mutation:** drop the `graduated` set from the `compactMemory` call (pass `{}`) → `alpha` survives (under cap, no cap pressure) → test FAILS. Proves the wiring is load-bearing.

**Test C — dry-run mutates nothing.** Read `memory.md` bytes before; run the verb WITHOUT `--apply` with an injected `graduated` that would retire a block; assert (a) the report lists the retire, (b) the live file is byte-identical after. **Test-the-test:** make dry-run accidentally call `compactMemory` on the live file → the file changes → FAILS.

**Test D — degradation.** `resolveTopicsDir` returns null (no `.agents/okf/`) and git absent → both injectors return `∅`, verb still runs cap-eviction only, never throws. Asserts the never-throw posture.

All fakes are injected via a `deps` param on `runMemoryCompactCli` (`{ runCheck?, readGraduatedSigs?, print? }`), mirroring `optimize-fix.ts`'s `OptimizeFixDeps` and `understand.ts`'s `deps.runGate` — so no test shells `git`/`node` (hermetic, matching the PIFLOW_HOME-hermetic discipline in the memory notes).

## 7. Files & sequencing

1. (test-first) Write `packages/cli/test/memory-compact.test.ts` (tests A–D) — RED.
2. Create `packages/cli/src/memory-compact.ts`: `runMemoryCompactCli` + `codeShiftedInjector` + `graduatedInjector` + `findRepoRoot` helper. Reuse `resolveTopicsDir`/`resolveSlice` from `./understand.js`, `deriveRecurrence`/`compactMemory`/`DEFAULT_MAX_LESSONS` from `@piflow/core`.
3. Wire `runMemoryCli` in `packages/cli/src/scaffold.ts` to dispatch `compact` → `runMemoryCompactCli`; add import.
4. Add the one HELP line in `packages/cli/src/cli.ts` under MEMORY.
5. Remove the stale TODO framing at `packages/core/src/optimize/memorize.ts:96` — replace with a one-line pointer that compaction now lives in `piflowctl memory compact` (out-of-band). (Comment-only; no behavior change to memorize.)
6. Run typecheck + the CLI + core optimize test suites; report green.

## 8. Self-check

- (a) All 9 bar sections present (Problem/Goal, Invariant audit, Design decision, Injectors, Wiring, Test-first, Files/sequencing, plus Open Questions in the tail). ✔
- (b) Every named file was READ this run: `compact.ts`, `memorize.ts`, `optimize/index.ts`, `optimize-fix.ts`, `cli.ts`, `optimize.ts`, `understand.ts`, `loop.ts`, `recurrence.ts`, `optimize-compact.test.ts`, `land.ts`, `scaffold.ts` (lines 800-843), `_generate.mjs`, memory-slices `SKILL.md`. No invented signature — `CompactOpts`/`RetiredLesson` (compact.ts:35-51), `deriveRecurrence` return shape (recurrence.ts:36-49), `resolveTopicsDir`/`resolveSlice` (understand.ts:117,136), `_generate.mjs --check <key>` exit-1-on-HEALTH (_generate.mjs:319-323), and `runMemoryCli` dispatcher (scaffold.ts:822) are all verified. ✔
- (c) Load-bearing tests A + B each have a concrete test-the-test mutation that makes them FAIL. ✔
- (d) No invariant violated: NO model call anywhere (both injectors are deterministic git/OKF-exit-code reads); the LOOP is untouched — compaction is an out-of-band VERB that mutates a live file only under explicit `--apply`, never inside `runOptimizeLoop`; `compactMemory` stays product-agnostic in core, injectors ride the CLI seam; the `codeShifted` injector uses pointer + resolve-at-read (the live `[[okf-slice]]`→`--check`), never a stored drift copy. ✔

# A4-memory-verb — piflowctl memory find|check subcommands

- **Cluster:** A-loop-tail
- **Effort:** small
- **Needs sign-off:** no
- **Depends on:** —
- **Shared-file risks:** packages/cli/src/skills.ts — also edited by any task adding a skills add-on (none in this batch); coordinate if A5-understand or B3-redesign add an add-on · packages/cli/scripts/bundle-skills.mjs — same dual-copy mirror; same coordination · packages/cli/src/cli.ts HELP — low-conflict text block, but A2/A3/B-tasks may also edit the optimize HELP region
- **Files touched:** packages/cli/src/memory.ts · packages/cli/src/scaffold.ts · packages/cli/src/understand.ts · packages/cli/src/cli.ts · packages/cli/src/skills.ts · packages/cli/scripts/bundle-skills.mjs · packages/cli/src/schema.ts · packages/cli/test/memory-verb.test.ts · packages/cli/test/skills.test.ts

**Open questions:**
- OQ1 (--strict now vs defer): should `memory check` ship with a `--strict` flag (dangling/code-shifted → exit 1, for a pre-commit hook) in this pass, or advisory-only? RECOMMENDED DEFAULT: ship `--strict` — it is ~5 lines, mirrors the OKF HEALTH-blocks semantics, and lets A3-compact's codeShifted retire-trigger gate on it later; advisory stays the default so nothing breaks.
- OQ2 (new memory.ts file vs inline in scaffold.ts): put the find/check handlers in a new packages/cli/src/memory.ts (mirroring understand.ts as its own file) or inline in scaffold.ts's runMemoryCli? RECOMMENDED DEFAULT: new file — scaffold.ts is already 842 lines and owns scaffolding; find/check are a distinct read concern. Fully reversible.
- OQ3 (--json output): add a `--json` structured-output mode to find/check now (for a programmatic triage/compact caller) or defer? RECOMMENDED DEFAULT: defer — no in-batch caller consumes it yet; the human-readable report meets the FIND-signal bar. Add when A3-compact or a scripted triage needs machine-readable code-shifted keys.

---
## 1. Objective & context

Add two read-only subcommands to `piflowctl memory` — **`find`** and **`check`** — that promote the already-built Leg-A recurrence engine (`deriveRecurrence`) and the memory-slices skill's MAINTAIN semantics into a deterministic CLI verb, mirroring the existing `understand` verb. Also wire the `memory-slices` skill into the `skills install` add-on bundle.

- **`memory find <templateDir> [--node <id>] [<symptom…>]`** — surface a node's standing lessons + cross-run recurrence (root/prevention/`[[okf-slice]]`/count) by reading per-node + system `memory.md` via `deriveRecurrence`. This is the reader the out-of-band triage/fixer calls to answer "has this node failed THIS way before, how often, what did we learn?" (the LAPSE-vs-SKILL signal) — the CLI face of memory-slices MODE A.
- **`memory check <templateDir> [<node…>]`** — a staleness/drift gate over `memory.md` that RIDES the OKF gate through each lesson's `[[okf-slice]]` pointer (never a separate drift engine). It is **advisory by default** (parity with `understand --check`'s "auto-region staleness is advisory") and reports which lessons are `code-shifted` (their linked slice is HEALTH-flagged) or dangling (linked slice absent). A `--strict` flag makes a dangling/code-shifted lesson a non-zero exit (blocking), for a pre-commit hook.
- Update `HELP MEMORY` (cli.ts:135-140) and the top-of-help one-liner index (cli.ts around :72-73) to document the two new subcommands.
- Add `memory` add-on → `memory-slices` skill to `SKILL_ADDONS` (skills.ts:28-33), `ADDON_SKILLS` (bundle-skills.mjs:22), so `skills install --with memory` ships the reader/maintainer skill.

**Grounding facts (verified this run):**
- `case 'memory'` (cli.ts:238-240) → `runMemoryCli` (scaffold.ts:822-842); line 824 hard-errors on any action ≠ `'scaffold'`.
- `deriveRecurrence({ templateDir, nodes? })` (recurrence.ts:49) reads `<templateDir>/nodes/<node>/memory.md` + `<templateDir>/memory.md`, parses lesson blocks (grammar at recurrence.ts:12-20: `### <sig heading>` · `sig:` · `recurrence:` · `[[okf-slice]]` · `**Root:**` · `**Prevention:**`), returns `RecurrenceIndex = Map<sig, { count, lesson? }>`. Exported from `@piflow/core` (index.ts:388, optimize/index.ts:10). Missing files ⇒ empty index, never throws.
- `understand.ts` is the mirror: THIN over the engine, injectable `runGate` dep for testing `--check` routing without shelling, `deps.cwd` search root, `out`/`err` writers, `process.exitCode` on failure.
- `resolveTopicsDir(startDir)` (understand.ts:117) walks up to `.agents/okf/topics/_generate.mjs`; `resolveSlice(topicsDir, key)` (understand.ts:136) dereferences a slice key → curated body or `null`. Both already imported into optimize-fix.ts (optimize-fix.ts:16) and re-exported.
- The OKF gate shell is `defaultRunGate` (understand.ts:151): `execFileSync('node', [_generate.mjs, '--check'|'--write', ...keys])` inheriting stdio, returns exit code. `check` must reuse THIS (via the same `runGate` injection seam), scoped to the keys extracted from lesson links.
- Add-on catalog is DUAL-COPY by design: `SKILL_ADDONS` in skills.ts (TS catalog) + `ADDON_SKILLS` in scripts/bundle-skills.mjs (plain .mjs prepack, can't import TS). Both list `okf-slices` today; a comment on each (skills.ts:27, bundle-skills.mjs:20-21) mandates keeping them in sync.
- The `memory-slices` skill dir already exists at repo-root `.claude/skills/memory-slices/SKILL.md` (16.5KB) — a byte-faithful copy target, ready to bundle.

## 2. Invariants honored (cite each)

- **Model PROPOSES/SCORES; code DECIDES/BOUNDS** — both new subcommands are PURE deterministic readers/gates: `find` folds `deriveRecurrence`'s counted index into a printed report; `check` rides the OKF `--check` gate. NO model call, NO network, NO prompt. All intelligence (writing the lesson prose) stays in the injected distiller/MEMORIZE seam, untouched here.
- **The loop never mutates a live file** — `find` and `check` are strictly READ-ONLY. `find` reads `memory.md`; `check` reads `memory.md` + shells to `understand --check` (which is itself advisory / non-mutating in check mode). Neither writes a byte. (The mutating memory write stays the out-of-loop MEMORIZE step, not touched by this task.)
- **SDK boundary law** — the reader ENGINE (`deriveRecurrence`) already lives in `@piflow/core` and is product-agnostic. This task adds only a THIN CLI binding in `packages/cli/src/` that calls it, exactly as `understand.ts` binds the OKF engine. No product data, no model, no network enters core.
- **Pointer + resolve-at-read** — `check` does NOT embed or copy the OKF slice body into memory. It reads the lesson's `[[okf-slice]]` POINTER and rides that slice's `--check` at gate time (memory-slices SKILL.md:143: "the memory drift gate is not separate machinery — it RIDES the OKF gate through the link"). No copy is ever created; freshness is resolved fresh each run.
- **test-first + mutation-verified, no over-hardcoding** — see §6. The load-bearing test asserts OBSERVABLE behavior (recurrence count + lesson prose surfaced for a real memory.md fixture; a code-shifted lesson flagged when its linked slice fails `--check`), each with a concrete mutation that makes it fail.

## 3. Design decisions

**D1 — `find` reads a templateDir directly (not a runDir), unlike `understand`.** `understand` walks up to `.agents/okf`; but `memory.md` lives under `<templateDir>/nodes/<id>/` and `<templateDir>/memory.md`. `find` takes the templateDir as a positional (same as `memory scaffold` at scaffold.ts:829). Honors D1: no run context needed — the reader is a pure function of the template's memory files. `--node <id>` scopes to one node (passed straight to `deriveRecurrence`'s `nodes?` param); bare = discover all node dirs (engine default).

**D2 — `find`'s output is a report, not the raw Map.** Mirror `understand`'s reader output: for each lesson matched, print the symptom signature (the `### heading` — but note `deriveRecurrence` keys by `sig:`, not the heading, and drops the heading text), the `recurrence:` count, the `[[okf-slice]]` link, and Root/Prevention. **Constraint discovered:** `deriveRecurrence` returns only `{ sig, count, lesson }` — it does NOT retain the human `### heading` symptom text. For `find`'s reader output we want that heading. **Decision:** `find` prints from the `RecurrenceIndex` (sig + count + lesson.root/prevention/okfSlice) — sufficient for the triage signal (bucket + evidence), which is what the skill's FIND output shape requires (memory-slices SKILL.md:80-82). The `### heading` is cosmetic; the machine `sig:` IS the canonical key. This keeps `find` a pure fold over the existing engine with ZERO new parsing surface. When a `<symptom…>` query is given, filter the index to entries whose `sig` contains the query substring (deterministic, case-insensitive) — same "substring over signature" discipline as the skill's grep-the-signature step.

**D3 — `check` reuses the SAME lesson-block grammar but needs the `[[okf-slice]]` links, which `deriveRecurrence` already parses into `lesson.okfSlice`.** So `check` can ALSO fold over `deriveRecurrence`'s output: collect the DISTINCT set of `lesson.okfSlice` keys across all lessons, then ride the OKF gate on exactly those keys (`runGate('check', topicsDir, sliceKeys)`). A lesson whose `okfSlice` is absent from the topics dir (dangling pointer, `resolveSlice` returns null) is flagged; a lesson whose slice FAILS `--check` (non-zero from the gate) is `code-shifted`. This means `check` needs `resolveTopicsDir(templateDir)` to locate the engine — reuse the existing helper. Honors the "rides the OKF gate" invariant with no new drift machinery.

- **Advisory vs blocking:** default = advisory (report, exit 0 even when lessons are code-shifted/dangling — parity with `understand`'s "auto-region staleness is advisory" at understand.ts:172). `--strict` = a dangling or code-shifted lesson sets `process.exitCode = 1` (for a pre-commit hook, mirroring the OKF HEALTH-blocks semantics). **Open Question OQ1** records whether `--strict` should ship now or defer.

**D4 — Injectable gate + cwd deps, exactly like `understand`.** `runMemoryCli` gains an optional `deps` param (default `{}`) carrying `runGate?` and `cwd?`, so the `check` path is testable without shelling to `_generate.mjs` (the understand test at understand.test.ts:188-207 is the template). `find` needs no injection (pure fs read of a fixture templateDir).

**D5 — Dispatch refactor is minimal.** scaffold.ts:823-828 currently does `if (action !== 'scaffold') error`. Replace with a `switch (action)` over `'scaffold' | 'find' | 'check'`, default → the same usage error but listing all three actions. Keep `scaffold` behavior byte-identical.

**D6 — Where the code lives.** Two options: (a) extend `runMemoryCli` in scaffold.ts inline, or (b) create a new `packages/cli/src/memory.ts` housing `runMemoryFind`/`runMemoryCheck` and have scaffold.ts's `runMemoryCli` dispatch into them. **Decision: (b)** — scaffold.ts is already 842 lines and owns scaffolding; the find/check readers are a distinct concern (mirroring how `understand.ts` is its own file, not folded into scaffold.ts). `runMemoryCli` stays the dispatcher in scaffold.ts and imports the two new handlers. This keeps one commit = one idea and avoids bloating scaffold.ts. **OQ2** records this as a reversible structural call.

## 4. Files to change (exhaustive)

1. **`packages/cli/src/memory.ts`** (NEW) — `runMemoryFind(argv, deps)` and `runMemoryCheck(argv, deps)`. Imports `deriveRecurrence`, `RecurrenceIndex`, `RecurrenceHit` from `@piflow/core`; `resolveTopicsDir` from `./understand.js` (already exported); a shared `defaultRunGate`-style shell (reuse understand's — see step below). Pure `out`/`err` writers + `process.exitCode`.
2. **`packages/cli/src/scaffold.ts`** — `runMemoryCli` (822-842): swap the `if (action !== 'scaffold')` guard for a 3-way dispatch; update `MEMORY_USAGE` (816) to list `find` + `check`; import the two handlers from `./memory.js`.
3. **`packages/cli/src/understand.ts`** — EXPORT `defaultRunGate` (currently a module-private fn at :151) so `memory check` shells to the OKF engine through the SAME code path (no duplicate shell). One-line `export` addition. (Alternatively duplicate a 12-line shell in memory.ts — but reuse is the CLAUDE.md discipline; exporting the existing one is cleaner and keeps the two gates provably identical.)
4. **`packages/cli/src/cli.ts`** — `HELP` MEMORY block (135-140): add `find <templateDir> [--node <id>] [symptom…]` and `check <templateDir> [node…] [--strict]` sub-entries. Add/update the top index one-liner near :72-73 to mention `memory find|check`. No dispatch change (case 'memory' already routes to `runMemoryCli`).
5. **`packages/cli/src/skills.ts`** — `SKILL_ADDONS` (28-33): add `memory: { skills: ['memory-slices'], description: 'per-node memory lessons + recurrence — piflowctl memory find|check reads them (Leg A)' }`.
6. **`packages/cli/scripts/bundle-skills.mjs`** — `ADDON_SKILLS` (22): add `'memory-slices'` (dual-copy discipline; comment already mandates mirroring skills.ts).
7. **`packages/cli/src/schema.ts`** (line 169) — the one-line `skills install` summary lists `(+ opt-in add-ons like okf)`; extend to `okf/memory` for accuracy. (Optional-but-consistent; grep showed this string.)
8. **`packages/cli/test/memory-verb.test.ts`** (NEW) — the test-first suite (§6).
9. **`packages/cli/test/skills.test.ts`** — extend the add-on suite to assert `--with memory` installs `memory-slices` byte-faithfully + writes the manifest (mirror the `understand`/`okf-slices` cases at :144-238).

## 5. Step-by-step implementation

1. **[test-first]** Write `packages/cli/test/memory-verb.test.ts` per §6 (RED). Run it, confirm the load-bearing cases FAIL for the right reason (unknown action / not-yet-implemented).
2. Export `defaultRunGate` from understand.ts (change `function defaultRunGate` → `export function defaultRunGate`). Verify the existing understand test still green (no behavior change).
3. Create `packages/cli/src/memory.ts`:
   - `runMemoryFind(argv, deps: { cwd?: string } = {})`: parse positional templateDir (required; error+exit 1 if absent, like scaffold.ts:830-833), `--node <id>`, and remaining positionals joined as the symptom query. Call `deriveRecurrence({ templateDir, nodes: node ? [node] : undefined })`. If empty → print "no standing lessons for <scope> (recurrence 0 — first occurrence)" (honest, never invents). Else, for each `[sig, hit]` (optionally filtered by query substring on `sig`, case-insensitive), print sig · `recurrence: N` · `[[okfSlice]]` if present · Root/Prevention if present. Sort deterministically (sig asc). Print a trailing "validate freshness: piflowctl memory check <templateDir>".
   - `runMemoryCheck(argv, deps: { cwd?: string; runGate?: ... } = {})`: parse templateDir + optional node positionals + `--strict`. `deriveRecurrence` to get lessons; collect DISTINCT `lesson.okfSlice` keys. `resolveTopicsDir(templateDir)` → if null, report "no .agents/okf substrate; memory freshness gate is skipped (advisory)" and exit 0 (advisory) — a template without an OKF map simply has no ride-along gate. Else `gate = deps.runGate ?? defaultRunGate; code = gate('check', topicsDir, sliceKeys)`. Report each lesson's slice as fresh / code-shifted (gate non-zero) / dangling (`resolveSlice` null). Advisory: exit 0 unless `--strict` AND (any dangling OR gate non-zero) → exitCode 1.
4. Refactor `runMemoryCli` in scaffold.ts to a 3-way switch dispatching to `scaffold`(existing) / `runMemoryFind` / `runMemoryCheck`; thread the `deps` through (add an optional `deps` param to `runMemoryCli` so cli.ts stays `await runMemoryCli(rest)` and tests can inject). Update `MEMORY_USAGE`.
5. Update `HELP` in cli.ts (MEMORY block + index one-liner).
6. Add the `memory` add-on to `SKILL_ADDONS` (skills.ts) and `ADDON_SKILLS` (bundle-skills.mjs); update schema.ts:169 string.
7. Extend skills.test.ts with the `--with memory` install + byte-faithful + manifest cases.
8. Run the full cli test suite + typecheck. Confirm all green. Confirm the RED tests from step 1 now pass.
9. Commit as `feat(cli): piflowctl memory find|check — promote the Leg-A recurrence reader + freshness gate` (+ a second commit for the skills-bundle wire if it reads cleaner split).

## 6. Test-first plan (the load-bearing test + its mutation)

**File:** `packages/cli/test/memory-verb.test.ts`. Fixture: `fs.mkdtemp` a templateDir with `nodes/build/memory.md` containing a real lesson block:
```
### build wrote no artifact
sig: build::no-artifact
recurrence: 3
[[runner]]
**Root:** the prompt never named the output path
**Prevention:** always echo the artifact path in the final turn
```
plus a system `memory.md` with a distinct lesson.

**LB test 1 (`find` surfaces the counted lesson):**
```
await runMemoryFind([templateDir, '--node', 'build']);
expect(out).toContain('build::no-artifact');
expect(out).toContain('recurrence: 3');
expect(out).toContain('always echo the artifact path'); // the prevention prose reached triage
expect(out).toContain('runner'); // the [[okf-slice]] pointer surfaced
```
- **Test-the-test mutation:** hard-code `find` to print an empty report (skip the `deriveRecurrence` fold). The test FAILS on the missing `recurrence: 3` + prevention prose → proves it asserts the real read, not the presence of a header.
- **Second mutation (guards D2 correctness):** change `find` to print `recurrence: 0` for every lesson (ignore the parsed count). Test FAILS on `recurrence: 3` → proves the count is the ACTUAL parsed value, not a constant. (No over-hardcoding: the assertion is on observable surfaced signal a downstream triage agent consumes, not on internal call shape.)

**LB test 2 (`check` rides the OKF gate + flags code-shifted — via injected gate):**
```
const calls = [];
const runGate = (mode, dir, keys) => { calls.push({ mode, keys }); return 1; }; // simulate slice HEALTH-failure
await runMemoryCheck([templateDir], { cwd: templateDir, runGate });
expect(calls[0].mode).toBe('check');
expect(calls[0].keys).toContain('runner'); // it rode the gate on the lesson's LINKED slice, not all slices
expect(out).toMatch(/code-shifted|stale/i); // the failing slice's lesson is flagged
expect(Number(process.exitCode ?? 0)).toBe(0); // ADVISORY by default (parity with understand)
```
- **Test-the-test mutation:** make `check` call the gate with a hard-coded key list (e.g. `[]` or `['*']`) instead of the extracted `lesson.okfSlice` set. The `keys).toContain('runner')` assertion FAILS → proves `check` extracts the pointer from the actual lesson, honoring resolve-at-read (not a blanket gate). This is the mutation that pins the load-bearing "rides the link" invariant.
- **Advisory mutation:** flip default to exit 1 on gate failure. The `exitCode).toBe(0)` assertion FAILS → pins the advisory-by-default decision. A separate `--strict` case asserts exit 1.

**skills.test.ts extension (byte-faithful add-on):** mirror the `--with understand` case (skills.test.ts:144-154 + the anti-drift :227-238), swapping `understand`→`memory`, `okf-slices`→`memory-slices`. Mutation to test-the-test: forget to add `memory-slices` to `ADDON_SKILLS` in bundle-skills.mjs → the dev-fallback `only` filter excludes it → the `fs.access(memory-slices/SKILL.md)` assertion FAILS. This is the test that pins the dual-copy discipline.

## 7. Risks & rollback

- **Shared-file coupling with A2/A5/A3:** this task edits `skills.ts` + `bundle-skills.mjs` (add-on catalog) and `cli.ts` HELP — none of which A2-distiller/B1-pareto (driver.ts types) touch. But `check`'s `code-shifted` output is the SAME signal A3-compact's `codeShifted` retire-trigger consumes (fed by `understand --check`). Coordinate: `memory check` should emit the code-shifted set in a shape A3 can consume programmatically if A3 wants to call it — but A3 currently rides `understand --check` directly, so no hard dependency; flag as a soft coupling. It does NOT block A4.
- **`defaultRunGate` export** is additive (a private fn becomes public) — zero behavior change to `understand`, verified by the existing understand test staying green. Rollback = revert the `export` keyword + inline a private copy in memory.ts.
- **Dual-copy drift** (skills.ts vs bundle-skills.mjs) is the classic footgun; the skills.test.ts byte-faithful case is the guard that catches a missed mirror. If prepack isn't run in the test env, the dev-fallback path (resolveSkillsSrc → repo-root `.claude/skills`) is what the test exercises, and the `memory-slices` dir already exists there, so the add-on lands via the `only` allowlist regardless of prepack.
- **Rollback:** all changes are additive/isolated. Delete memory.ts, revert the scaffold.ts dispatch to the `if (action !== 'scaffold')` guard, revert the two catalog entries + HELP. No migration, no data touched.

## 8. Out of scope (explicit non-goals)

- NO memory-WRITE surface (`memorize`/MEMORIZE stays the injected out-of-loop distiller step; `find`/`check` are strictly read-only).
- NO new drift engine — `check` RIDES `understand --check`; it does not parse code or compute anchors.
- NO change to `deriveRecurrence` / the `@piflow/core` engine (it is already live; we only bind it). If `find` wanted the `### heading` symptom text (dropped by the engine, see D2), that would be a core change — deferred, not needed for the triage signal.
- NO `--json` output mode for `find`/`check` in this pass (the skill's structured FIND shape is a follow-up if a programmatic caller needs it; recorded as OQ3).
- NO seeding of `.agents/okf/` or `memory.md` into a target repo via `skills install` (same boundary the `understand` add-on respects — skills.ts:221-222: ships the SKILL only, seeding is a separate step).

## 9. Self-check (bar audit)

- All 9 sections present and substantial: yes.
- Every named file was READ this run: cli.ts (dispatch + HELP), scaffold.ts (runMemoryCli), recurrence.ts (engine), understand.ts (mirror + defaultRunGate), skills.ts (add-on catalog), bundle-skills.mjs (dual copy), understand.test.ts + skills.test.ts + scaffold-memory.test.ts (test conventions), optimize-fix.ts (how recurrence is consumed), core index exports. schema.ts:169 confirmed via grep. No invented signature.
- Load-bearing tests have concrete test-the-test mutations: `find` empty-report + constant-count mutations; `check` blanket-key-list + advisory-flip mutations; skills byte-faithful missed-mirror mutation. Each FAILS when the code is wrong.
- No invariant violated: no model/network in core (only a CLI bind of an existing core engine); the two subcommands are read-only (loop-never-mutates honored); pointer + resolve-at-read (check rides the `[[okf-slice]]` link, never copies); SDK boundary intact.

# A1-land — Wire the physical adopt/LAND step

- **Cluster:** A-loop-tail
- **Effort:** medium
- **Needs sign-off:** YES
- **Depends on:** A2-distiller, B1-pareto
- **Shared-file risks:** packages/core/src/optimize/driver.ts — A2-distiller adds a root-cause field to CandidateEdit/FixGateResult and B1-pareto makes candidates set-valued on the SAME driver types A1 extends with liveRoot on FixGateRecord + liveRootFor on FixGateStages; coordinate the type edit so the second lander rebases onto the shared shape.
- **Files touched:** packages/core/src/optimize/land.ts · packages/core/src/optimize/driver.ts · packages/core/src/optimize/index.ts · packages/cli/src/optimize-adopt.ts · packages/cli/src/cli.ts · packages/core/test/optimize-land.test.ts · packages/cli/test/optimize-adopt-cli.test.ts

**Open questions:**
- Does copyScope guarantee the candidate dir mirrors the live editable scope 1:1 (same relative layout)? Recommended default: assume 1:1 mirror + require the binding to expose an injected liveRootFor(defect)→liveDir; defer a transforming-copyScope to a per-file manifest path-map. HALT if game-omni's copyScope is not a mirror.
- Flat basename '.bak' backups collide across files with the same basename. Recommended default: ship MVP with a warning + basename backups, namespace by node/relPath as a fast-follow.
- Should --adopt git-add/commit the landed files? Recommended default: NO — keep --adopt VCS-agnostic; committing stays the human's/agent's separate step.

---
## 1. Objective / Definition of Done

Make an ACCEPTED, gated fix physically land on the live file(s) — safely (backup-first) and reversibly — via an **explicit, opt-in, out-of-loop** step. Today `adoptFile` (`packages/core/src/optimize/land.ts:78-92`) is built + unit-tested but has **zero live caller**: `optimize --fix --auto-adopt` only stamps `landed:'adopted'` into the manifest (`packages/cli/src/optimize-fix.ts:229-233` via `writeStagingManifest`) and physically lands nothing. This is the LEAD task — it unblocks "the overlord acts."

**DONE when:**
- A new deterministic verb `piflowctl optimize --adopt <manifestPath> [--dry-run] [--backup-dir <d>]` reads a staging manifest, selects the `landed:'adopted'` records, and for each physically overwrites the live file(s) from the candidate copy, backing up first — calling the existing `adoptFile`.
- Landing is a **separate command**, never a side effect of `--fix`/`--rounds` (honors the loop-never-mutates invariant).
- The manifest carries enough to map candidate→live (a new `liveRoot` field per record, written at STAGE time) so `--adopt` is a pure deterministic replay of a recorded decision — no re-scoring, no model, no binding load.
- Re-running `--adopt` on the same manifest is safe (idempotent-adjacent: it re-lands identical bytes and refreshes the backup; documented, not silently skipped — see §5).
- Exit code: `0` on a clean adopt, `2` on a malformed/missing manifest, `1` if any file adopt throws mid-run (partial-land is reported, not swallowed).
- test-first, mutation-verified (§6).

## 2. Design decision + justification

**DECISION: a new `optimize --adopt <manifest>` verb (Option A), NOT auto-landing inside `--auto-adopt` (Option B).**

Rationale, keyed to the load-bearing invariants:

- **The loop NEVER mutates a live file** (v1.5 §6 `cycle.py:90`; `driver.ts:4`). `--fix` and `--rounds` run the driver, which is straight-line code that touches only candidate copies. If `--auto-adopt` physically landed, then *running the loop* would mutate live files — a direct violation, because `--rounds N` calls the same `makeFixGateRunner` with the same `policy.autoAdopt`. Option B cannot be made safe without special-casing single-shot vs loop inside the shared runner, which is exactly the divergence the codebase avoids (`optimize-fix.ts:162-191` deliberately shares wiring). A **separate verb** is the only way to keep landing strictly out-of-loop.
- **Model PROPOSES/SCORES; deterministic code DECIDES/BOUNDS/LANDS** (`gate.ts:3`). `--adopt` is pure deterministic replay of an already-recorded decision (`landed:'adopted'` in the manifest). It loads **no binding**, calls **no oracle/fixer/model**, does no scoring. It is the "LANDS" half made concrete, and it lives entirely in code.
- **SDK boundary law** (`CLAUDE.md`): `adoptFile`/`writeStagingManifest` stay in `@piflow/core` (pure fs, product-agnostic). The new *verb* is a thin CLI renderer in `packages/cli/src/` that reads the manifest and drives the core primitive — mirroring how `optimize.ts` is a thin renderer over `scoreRun`/`triage`. No product data enters core.
- **`--auto-adopt` keeps its current meaning** (a decision flag): with `--auto-adopt`, an eligible win is *recorded* as `landed:'adopted'` in the manifest (already true, `driver.ts:198`); without it, wins record `landed:'staged'`. `--adopt` then lands whatever the manifest marked `adopted`. This preserves the per-target LAND policy (`gate.ts:44`: ARCH → `stage-for-human` → never `adopted`) end-to-end: an ARCH edit can NEVER be auto-landed because it never gets `landed:'adopted'`, and `--adopt` only lands `adopted` records.

This keeps a clean split: `--fix`/`--rounds` DECIDE + STAGE (record `adopted`/`staged`/`discarded`); `--adopt` EXECUTES the `adopted` decisions on disk. The human (or a wrapper script) explicitly opts in by running the second command.

**Sub-decision — what "the live file" is.** `adoptFile` is single-file; but `candidateRef` is a **directory** (`prepareCandidate = copyScope(node)`, `replay.ts:107`; `CopyScope = (node) => Promise<string>` returns a dir, `replay.ts:54`). The candidate dir is a *copy of the node's editable scope*. The manifest today records only `candidateRef` (the copy dir) — it does **not** record the LIVE root the copy mirrors. **A1 must persist that live root.** So `--adopt` walks each accepted record's candidate dir and, for each file, computes the mirror path under the recorded `liveRoot`, then calls `adoptFile(liveRoot/relPath, candidateDir/relPath, {backupDir})`. This reuses `adoptFile` unchanged (including its NEW-FILE branch for a candidate file with no live counterpart).

## 3. Files touched (exhaustive) + what each change is

1. **`packages/core/src/optimize/driver.ts`** — add `liveRoot: string` to `FixGateRecord` (after `candidateRef`, line ~89). The driver must record, per record, the live directory the candidate mirrors. Populate it in the two `records.push` paths. **SOURCE of `liveRoot`:** the driver does not know it — it only has `candidateRef` from the injected `prepareCandidate`. So we add an OPTIONAL injected resolver `liveRootFor?: (defect: Defect) => string` to `FixGateStages` (default: unset → `liveRoot: ''`, meaning "not landable deterministically → adopt must skip/error for this record"). The product binding supplies it (it owns `copyScope`, so it owns the reverse mapping). This keeps core product-agnostic: core stores the string, the product computes it. **COUPLING NOTE:** A2-distiller and B1-pareto also change `FixGateRecord`/`CandidateEdit` types here — coordinate the type edit (see sharedFileRisks).

2. **`packages/core/src/optimize/land.ts`** — (a) add `liveRoot: string` to `ManifestRecord` (line 24-34) and copy it through in `writeStagingManifest`'s `.map` (line 40-50). (b) add a NEW pure function `adoptFromManifest(manifest, opts: { backupDir: string; dryRun?: boolean }): Promise<AdoptReport>` that: parses the manifest shape, selects `records.filter(r => r.landed === 'adopted')`, and for each walks `r.candidateRef` recursively, computing `relPath` and calling `adoptFile(path.join(r.liveRoot, rel), path.join(r.candidateRef, rel), {backupDir})` for every file (skip when `dryRun`). It returns a typed `AdoptReport { adopted: {node, file, backupPath}[]; skipped: {node, reason}[]; errors: {node, file, message}[] }`. A record with empty `liveRoot` or a missing `candidateRef` dir goes to `skipped` with a reason (never a throw — a stale manifest must degrade, not crash). This is still pure fs, product-agnostic — it belongs in core.

3. **`packages/cli/src/optimize-adopt.ts`** (NEW) — the thin verb. `parseOptimizeAdoptArgs(argv)` → `{ manifest, dryRun, backupDir? }`; `runOptimizeAdoptCli(argv, deps?)`. Reads the manifest JSON, defaults `backupDir` to `<dirname(manifest)>/backups`, calls `adoptFromManifest`, prints a one-line summary to stdout + a per-file detail block, and sets `process.exitCode` (0/1/2 per §1). Injectable `print` for tests, mirroring `optimize-fix.ts`.

4. **`packages/cli/src/optimize.ts`** OR **`packages/cli/src/cli.ts`** — routing. The dispatcher already branches inside `case 'optimize'` (cli.ts:265-272) on `--rounds`/`--fix`. Add `else if (rest.includes('--adopt')) await runOptimizeAdoptCli(rest)` BEFORE the bare-`optimize` fallthrough. Import `runOptimizeAdoptCli` at the top (cli.ts:29-31 region).

5. **`packages/cli/src/cli.ts`** HELP text (line ~62-66) — document `piflowctl optimize --adopt <manifest> [--dry-run] [--backup-dir <d>]  physically land the manifest's accepted edits (backup-first; the explicit out-of-loop adopt)`.

6. **`packages/core/src/optimize/index.ts`** — export `adoptFromManifest` + its `AdoptReport` type (line 38-39 region, beside `writeStagingManifest, adoptFile`).

7. **TESTS (§6):** `packages/core/test/optimize-land.test.ts` (extend: `adoptFromManifest`), `packages/cli/test/optimize-adopt-cli.test.ts` (NEW).

## 4. Step-by-step implementation order (executor follows this)

1. **Write the failing core test first** (`optimize-land.test.ts`, §6 load-bearing test) — `adoptFromManifest` over a manifest with one `adopted` + one `staged` + one `discarded` record, on a real tmp dir tree. Assert only the `adopted` record's file is overwritten live, the backup holds the old bytes, and staged/discarded are untouched. Run it → RED (function doesn't exist).
2. **Add `liveRoot` to `ManifestRecord`** + thread it in `writeStagingManifest` (`land.ts`).
3. **Add `adoptFromManifest`** (`land.ts`) — make the test GREEN.
4. **Add `liveRoot` to `FixGateRecord` + optional `liveRootFor` stage** (`driver.ts`); populate both `records.push` sites. Update the existing `optimize-driver.test.ts` fixtures if they assert on record shape (verify — likely additive, back-compat since `liveRoot` defaults to `''`). Coordinate the type edit with A2/B1 (§sharedFileRisks).
5. **Export** from `index.ts`.
6. **Write the failing CLI test** (`optimize-adopt-cli.test.ts`) — arg-parse + one adopt smoke that writes a live file from a candidate + a `--dry-run` that lands nothing. RED.
7. **Add `optimize-adopt.ts`** verb → GREEN.
8. **Wire routing + HELP** (`cli.ts`).
9. **Run** `npx vitest run packages/core/test/optimize-land.test.ts packages/cli/test/optimize-adopt-cli.test.ts` + a full typecheck. Report results.

## 5. Backup / idempotency / re-run semantics

- **Backup:** `adoptFile` already backs up `<basename>.bak` in `backupDir` before overwrite (`land.ts:86-89`), and treats a missing live file as the NEW-FILE branch (no backup). `--adopt` reuses this unchanged. Default `backupDir = <dirname(manifest)>/backups` so backups live beside the staging record; `--backup-dir` overrides.
- **KNOWN BACKUP LIMITATION (record it):** `adoptFile`'s backup name is `<basename>.bak` in a flat `backupDir` — two files with the same basename across nodes/dirs COLLIDE (second backup clobbers the first). For the MVP this is acceptable because a targeted `--fix --node <id>` typically lands one node's small scope; the plan MUST surface this in the summary ("backups are basename-keyed; collisions overwrite") and record it as future work (namespace the backup path by node/relPath). Do NOT silently rely on uniqueness. (This is an Open Question — see below.)
- **Idempotency / re-run safety:** re-running `--adopt` on the same manifest re-lands identical candidate bytes onto the (now-identical) live file and re-writes the `.bak` — the SECOND run's backup would capture the *already-adopted* bytes, destroying the true original. Mitigation: `adoptFromManifest` MUST skip a file whose live content already byte-equals the candidate (compare before adopting) — this makes re-runs no-ops AND preserves the first backup. This is a load-bearing safety property and gets its own test (§6). `--dry-run` reports what WOULD land without touching disk or backups.
- **Partial-land integrity:** if file 3 of 5 throws (e.g. permission), earlier files stay landed (their backups exist → reversible). The report lists `adopted` + the `errors`; exit code 1. No rollback (out of scope; the backups ARE the recovery path) — but this is reported, never swallowed.

## 6. Test-first plan (meaningful, mutation-verified)

**Load-bearing test** (`optimize-land.test.ts`, extends the existing `adoptFile` block):

> `adoptFromManifest` lands ONLY `landed:'adopted'` records, backs up first, and leaves staged/discarded untouched.

Setup: a tmp tree with `live/nodeA/hook.ts` = `"OLD"`, `live/nodeB/x.ts` = `"KEEP"`; candidate dirs `candA/hook.ts` = `"NEW"`, `candB/x.ts` = `"CHANGED"`. A manifest with record A `{landed:'adopted', candidateRef: candA, liveRoot: live/nodeA}`, record B `{landed:'staged', candidateRef: candB, liveRoot: live/nodeB}`. Call `adoptFromManifest(manifest, {backupDir})`.
- ASSERT `live/nodeA/hook.ts` === `"NEW"` (adopted landed).
- ASSERT `live/nodeB/x.ts` === `"KEEP"` (staged NOT landed).
- ASSERT the backup file holds `"OLD"` (backup-first).
- ASSERT `report.adopted` has exactly one entry (node A).

**Test-the-test mutation (concrete):** in `adoptFromManifest`, change the filter `r.landed === 'adopted'` → `r.landed !== 'discarded'` (i.e. also land staged). The load-bearing test MUST FAIL on the `live/nodeB/x.ts === "KEEP"` assertion (it would become `"CHANGED"`). A second mutation: delete the `fs.copyFile(livePath, backupPath)` in `adoptFile` — the backup-holds-`"OLD"` assertion MUST fail. If neither mutation reddens a test, the test is coverage theater — fix it before landing.

**Second core test — re-run idempotency:** call `adoptFromManifest` TWICE. After run 2, ASSERT the backup STILL holds the true original `"OLD"` (not the already-adopted `"NEW"`), proving the byte-equal skip. Mutation: remove the byte-equal skip → this test fails (backup becomes `"NEW"`).

**CLI test** (`optimize-adopt-cli.test.ts`): (a) `parseOptimizeAdoptArgs` extracts `manifest`, `--dry-run`, `--backup-dir`; (b) `runOptimizeAdoptCli` over a written manifest lands the live file + prints a summary containing the adopted count; (c) `--dry-run` lands NOTHING (live file unchanged) but still reports what would land; (d) a missing manifest path sets `process.exitCode = 2` and prints an actionable error. Each assertion observes real disk state or exit code — never internal intent.

**NO over-hardcoding:** tests assert observable disk bytes + exit codes + report counts, never the exact summary wording or internal call order.

## 7. Invariant self-audit (each choice → the invariant it honors)

- Separate `--adopt` verb, never inside the loop → **loop never mutates a live file** (the runner/driver stay copy-only).
- `--adopt` loads no binding, no model, pure fs replay of a recorded decision → **model proposes/scores; code decides/bounds/LANDS**.
- `adoptFile`/`adoptFromManifest` stay in `@piflow/core` (pure fs); `liveRoot` is COMPUTED product-side via injected `liveRootFor`, core only stores the string → **SDK boundary (core is product-agnostic, no product data)**.
- ARCH → `stage-for-human` → never `landed:'adopted'` (`gate.ts:44`) → `--adopt` never lands ARCH → **per-target LAND policy preserved end-to-end**.
- No Leg-A/Leg-B pointer touched here (adopt is downstream of enrich) → **pointer-resolve invariant unaffected**.

## 8. Risks / coupling to flag

- **driver.ts type edit collides with A2-distiller (root-cause field on `CandidateEdit`/`FixGateResult`) and B1-pareto (set-valued candidates).** All three add fields to the same `FixGateRecord`/driver types. Coordinate: land A1's `liveRoot` as a small additive field; whoever lands second rebases onto the shared type. Flagged in dependsOn + sharedFileRisks.
- **land.ts flat basename backup collision** (§5) — MVP-acceptable, documented, follow-up.
- **B4-fixer / A1 both concern editing live files** — B4 is the fixer editing the candidate copy; A1 lands the copy. No file overlap, but the *conceptual* boundary (copy vs live) must stay crisp; A1 is the ONLY writer of live files.

## 9. Open Questions (recommended defaults — HALT points)

1. **Does `copyScope` guarantee the candidate dir MIRRORS the live editable scope 1:1 (same relative layout), so a deterministic tree-walk suffices?** If yes, the injected `liveRootFor(defect) → liveDir` + relative-path walk is enough. If `copyScope` flattens or transforms paths, `--adopt` needs a per-file manifest map instead. **RECOMMENDED DEFAULT:** assume 1:1 mirror (the natural `copyScope` contract — "copy the node's editable scope to a candidate dir"), require the binding to expose `liveRootFor`, and DEFER a transforming-copyScope to a manifest path-map. This is the game-omni binding's contract to satisfy; if game-omni's `copyScope` is not a mirror, HALT and get the mapping shape from the user.
2. **Flat basename backup collision (§5):** ship MVP with basename `.bak` + a warning, or namespace backups by node/relPath now? **RECOMMENDED DEFAULT:** ship the warning now; namespace as fast-follow (keeps A1 minimal, unblocks "the overlord acts").
3. **Should `--adopt` `git add`/commit the landed files?** **RECOMMENDED DEFAULT: NO** — landing is a filesystem op; VCS staging is the human's call (and the global git-workflow rule says the agent owns commits at coherent boundaries, not this primitive). Keep `--adopt` VCS-agnostic.

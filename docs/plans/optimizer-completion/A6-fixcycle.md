# A6-fixcycle — Provide + wire the fix-cycle ceiling counters

- **Cluster:** A-loop-tail
- **Effort:** small
- **Needs sign-off:** no
- **Depends on:** —
- **Shared-file risks:** packages/cli/src/optimize-fix.ts is also edited by A2-distiller and B1-pareto (they add fields to CandidateEdit/FixGateResult types imported here) and by A1-land (landing/adopt path) — this task only adds a factory fn + rewires the counter resolution inside makeFixGateRunner, so conflicts are localized to that fn; coordinate the import/type block with A2/B1.
- **Files touched:** packages/cli/src/optimize-fix.ts · packages/cli/src/index.ts · packages/cli/test/optimize-fix-cli.test.ts

**Open questions:**
- Default persistence location: I recommend <runDir>/optimize/.fixcycles-<node>.json (per-run, mirrors game-omni's proven shape and the existing staging/memorize sidecars). Alternative the user might prefer: ~/.piflow/<product>/fixcycles.json for a cross-run-dir aggregate (survives run-dir cleanup). Default = per-run run-dir sidecar unless the user wants counts to persist across runs.
- Malformed binding that exports exactly ONE of readFixCycles/bumpFixCycles: I recommend falling back to the default PAIR (safer — the ceiling still works) rather than silently disabling it. Alternative: throw a clear error at loadBinding time ('provide both or neither'). Default = fall back to the default pair; add a stderr warning.

---
## 1. Problem & Goal

`--fix-cycle-ceiling N` is a DETERMINISTIC per-node re-attempt bound in the overlord: once a node has consumed N failed fix cycles across `optimize --fix` invocations, the driver SKIPS it (escalate to a human) instead of looping forever on a structurally-unfixable node.

The core mechanism is fully built and tested (`packages/core/src/optimize/driver.ts:124-212`; `runFixGate` reads `stages.readFixCycles`, bumps via `stages.bumpFixCycles`, and the ceiling activates only when `opts.fixCycleCeiling != null && readFixCycles && bumpFixCycles` are ALL present — `driver.ts:132`). The CLI already parses the flag (`optimize-fix.ts:74`, `optimize-loop.ts:63`) and threads it into `FixGatePolicy`/`runFixGate` (`optimize-fix.ts:181-188`).

**The gap (verified):** the two counter STAGES (`readFixCycles`/`bumpFixCycles`) are declared OPTIONAL on `OptimizeBinding` (`optimize-fix.ts:34-36`) but **no binding shipped in THIS repo provides them**. The only real implementation, `makeFixCyclesPort`, lives OUT of the repo in `game-omni/packages/verify/optimize/scope.mjs:63-88` and is hand-wired into that product's `binding-live.mjs:24-26`. Consequently, for any binding a user authors against the piflow CLI, `--fix-cycle-ceiling` is silently inert (`ceilingActive === false`), so the escalation ceiling never activates in practice.

**Goal:** ship a DEFAULT, file-backed per-node fix-cycle counter at the CLI/product seam so `--fix-cycle-ceiling` actually bounds re-attempts even when a binding does not hand-roll its own port — WITHOUT changing core's contract (core keeps injecting the two hooks and persists nothing).

## 2. Invariant Alignment (cite each)

- **SDK boundary law** — counters are per-run PRODUCT/RUN data (a count of how many times we tried to fix node X on run Y). They MUST NOT live in `@piflow/core`. This plan puts the persistence in `packages/cli/src/optimize-fix.ts` (the product/CLI seam), keeping core's `readFixCycles?`/`bumpFixCycles?` injection contract byte-for-byte unchanged. Core still "persists NOTHING" (`driver.ts:131`, `optimize-fix.ts:33`).
- **Model PROPOSES; code DECIDES/BOUNDS** — the counter is pure deterministic bookkeeping (integer read/increment on disk); no model, network, or prompt. It is the bound; the fixer stays the only intelligence.
- **The loop never mutates a live file** — the counter sidecar is optimizer bookkeeping under `<runDir>/optimize/`, NOT a live template/source file. Writing it is not "landing a fix"; it records a rejected attempt. Physical fix landing stays a separate, opt-in `land.ts` step. Bumping is gated exactly where core already gates it: only after a REAL failed fix (rejected verdict with ≥1 edit — `driver.ts:197`), so an accept/0-edit/aborted proposal never touches the counter.
- **Pointer + resolve-at-read** — N/A to this task (no memory-leg cross-reference), noted for completeness.
- **test-first + mutation-verified** — the load-bearing behavior (bump→read round-trip, corrupt-tolerance, per-node isolation, and the wiring that makes the ceiling ACTIVE by default) gets a failing-first test with a concrete kill mutation (§6).

## 3. Design Decision: WHERE the counter lives + WHY

**Decision: persist under `<runDir>/optimize/.fixcycles-<node>.json`, one sidecar per node, provided as a CLI-seam default that fills in `readFixCycles`/`bumpFixCycles` when the binding omits them.**

Justification:
- **`<runDir>/optimize/` is the already-established optimizer-data location.** The default staging manifest already writes to `path.join(args.dir, 'optimize', 'staging')` (`optimize-fix.ts:229`), and MEMORIZE's signature sidecar lands under the run dir (`memorize.ts:24`). Co-locating the counter there keeps ALL per-run optimizer bookkeeping in one place and makes it disposable with the run.
- **Per-run, not `~/.piflow` global.** The counter semantically bounds re-attempts on a specific finished run's defects. game-omni's real port scopes to the run dir (`scope.mjs:52-56`) — this default MIRRORS the proven shape (`{ node, cycles, updatedAt }`, corrupt→0). Choosing the run dir keeps parity so a product can later drop-in its own port with no behavior surprise.
- **Why NOT `~/.piflow` (global index home):** the data-boundary memory says `~/.piflow` holds the GLOBAL mapping/index/snapshots (`products.json`, `index.json`), not per-run scratch. A per-node fix-attempt count is neither global nor a snapshot; putting it in `~/.piflow` would pollute the global home with per-run churn and complicate cleanup. Rejected. (Recorded as Open Question with this as the recommended default in case the user wants cross-run-dir aggregation instead.)
- **Why a CLI-seam DEFAULT (not "just document it"):** the whole point of the task is that the flag is inert unless a binding hand-rolls the port. A default that the CLI supplies when the binding omits the hooks makes `--fix-cycle-ceiling` work out-of-the-box for EVERY binding, while a binding that DOES export its own port (game-omni) transparently overrides it. This is the minimal change that closes the gap without a core change.

**Filename choice:** use `.fixcycles-<safeNode>.json` (sanitize `[^\w.-]→_`, matching `scope.mjs:54`). Do NOT reuse game-omni's exact `.optimize-fixcycles-` prefix — that prefix exists there to COEXIST with game-omni's *other* `verify/.fixcycles-*.json` loop (`fixcycles-port.test.mjs:60-82`); this repo has no such collision, and a binding that supplies its own port never invokes our default. Keep the shape (`{ node, cycles, updatedAt }`) so a product port and the default are interchangeable.

## 4. Implementation Plan (step by step)

All edits are in `packages/cli/src/optimize-fix.ts` (the seam). No core edit. No `optimize-loop.ts` edit needed — it composes `makeFixGateRunner(binding, …)` (`optimize-loop.ts:132`), so wiring the default INSIDE `makeFixGateRunner`/binding-resolution automatically covers the multi-round path too.

**Step 1 — write the default counter factory (new exported fn in `optimize-fix.ts`).**
Add `export function makeDefaultFixCyclesPort(runDir: string): { readFixCycles: (node: string) => number; bumpFixCycles: (node: string) => void }`. Mirror `scope.mjs:63-88` behavior exactly:
- path = `path.join(runDir, 'optimize', \`.fixcycles-${node.replace(/[^\w.-]/g, '_')}.json\`)`.
- `readFixCycles`: `existsSync` false → 0; parse; return `Number.isInteger(data.cycles) && data.cycles >= 0 ? data.cycles : 0`; catch → 0 (corrupt-tolerant, never throws).
- `bumpFixCycles`: read current (corrupt/absent → 0), `mkdirSync(dir, { recursive: true })`, `writeFileSync(JSON.stringify({ node, cycles: cycles+1, updatedAt: new Date().toISOString() }, null, 2) + '\n')`.
Use existing node imports (`path` already imported at `optimize-fix.ts:12`; add `existsSync, mkdirSync, readFileSync, writeFileSync` from `node:fs`).

**Step 2 — resolve the effective counter port: binding-provided OR default.**
The ceiling should be inert ONLY when the user did not ask for it (no `--fix-cycle-ceiling`). When they DID ask, the CLI supplies the default port if the binding omits one. Introduce a small resolver used by BOTH the single-shot path and `makeFixGateRunner`. Two viable placements — pick (b):
- (a) inside `makeFixGateRunner`: it already spreads `binding.readFixCycles`/`bumpFixCycles` at `optimize-fix.ts:181-182`. But it doesn't know the ceiling flag there (policy carries `fixCycleCeiling`), so it CAN gate on `policy.fixCycleCeiling !== undefined`.
- **(b) [chosen]** add the fallback INSIDE `makeFixGateRunner`, gated on `policy.fixCycleCeiling !== undefined`, so the counter is only materialized when the ceiling is actually requested (no stray sidecar files on every run). Concretely, replace the two spread lines (`optimize-fix.ts:181-182`) with a resolved `counter` const:
  ```
  const counter = binding.readFixCycles && binding.bumpFixCycles
    ? { readFixCycles: binding.readFixCycles, bumpFixCycles: binding.bumpFixCycles }
    : (policy.fixCycleCeiling !== undefined ? makeDefaultFixCyclesPort(runDir) : undefined);
  ```
  then spread `...(counter ?? {})` into the `runFixGate` stages. This honors: binding-provided port WINS (game-omni untouched); default fills in ONLY when a ceiling was requested and the binding gave neither hook; and if a binding provides exactly ONE of the two hooks (malformed), we fall back to the default pair rather than silently disabling the ceiling (or, alternatively, throw — see Open Questions).
- Because `makeFixGateRunner` is called by BOTH `runOptimizeFixCli` (`optimize-fix.ts:226`) and the loop stage (`optimize-loop.ts:132`), this single change covers both entry points — no `optimize-loop.ts` edit.

**Step 3 — keep the loader/validation unchanged.** `loadBinding` still only requires `oracle`/`copyScope`/`fixer` (`optimize-fix.ts:95-97`); the counter hooks stay OPTIONAL on the binding. The default makes them effectively always-present when a ceiling is set. No change to the "OPTIONALITY" test at `optimize-fix-cli.test.ts:154` semantics — but note that test's ASSERTION about the ceiling being "inert" with the fake binding will now change (see §5/§7): with the default port, `--fix-cycle-ceiling` is no longer inert. That test must be updated to assert the NEW correct behavior (ceiling now active via the default), not left asserting the old gap.

**Step 4 — export the factory** from `packages/cli/src/index.ts` alongside the other optimize-fix exports (currently index.ts does NOT re-export optimize-fix symbols at all — they're imported directly in tests via `../src/optimize-fix.js`). Adding an export is optional-but-recommended for a product that wants to reuse the default programmatically; minimally, `export { makeDefaultFixCyclesPort }` so it's part of the public surface. (Trivial; the load-bearing wiring is Step 2.)

## 5. Files Touched (exhaustive)

- `packages/cli/src/optimize-fix.ts` — add `makeDefaultFixCyclesPort` + fs imports; rewire the counter resolution in `makeFixGateRunner`.
- `packages/cli/src/index.ts` — re-export `makeDefaultFixCyclesPort` (public surface).
- `packages/cli/test/optimize-fix-cli.test.ts` — UPDATE the existing "OPTIONALITY … ceiling inert" test (`:154`) to reflect that the default port now activates the ceiling; add the new default-port unit + wiring tests (§6). This is a type/behavior-consumer update, not just an addition — flagged so the executor edits (not appends to) that file.

No core files. No `optimize-loop.ts`. No game-omni files (its own port keeps winning by precedence).

## 6. Test-First Plan (the load-bearing test + its kill mutation)

Write these BEFORE the impl (test-discipline). New/updated tests in `packages/cli/test/optimize-fix-cli.test.ts` (co-located with the seam it tests; the counter is pure fs bookkeeping → a real-tmpdir unit test, the right gate per test-discipline, not a mock).

**T1 (pure port round-trip) — the load-bearing behavior test.**
- `makeDefaultFixCyclesPort(tmpRun)`: fresh node reads 0; `bump('n')` then `read('n')` === 1; bump again → 2; the sidecar exists at `<tmpRun>/optimize/.fixcycles-n.json`; a second node `read('m')` === 0 (per-node isolation); a corrupt sidecar (`writeFileSync('{ not valid json')`) reads 0.
- **Concrete kill mutation (test-the-test):** change `bumpFixCycles` to write `cycles` (not `cycles+1`) — i.e. never increment. T1's `read('n') === 1 after one bump` and the `→2` assertion FAIL. Equally, replacing the corrupt-`catch → 0` with a re-throw makes the corrupt-tolerance assertion FAIL. Both prove the test observes real behavior, not intent.

**T2 (wiring — the ceiling is now ACTIVE by default) — the gap-closing test.**
This is what proves the TASK (the flag was inert; now it bounds). Drive `runOptimizeFixCli` with the FAKE binding (which exports NO counter hooks) against the gs01 fixture + injected `scoreRun`, with `--fix-cycle-ceiling 1`, on a tmp run dir pre-seeded so the target node already has `cycles: 1` (write `<runDir>/optimize/.fixcycles-<node>.json` with `{cycles:1}` before the call). Assert the result skips that node at the ceiling: capture the printed summary and assert it contains `node(s) escalated at the fix-cycle ceiling` (the `escalated` line at `optimize-fix.ts:231`), OR assert via `--watch-json` that a `fix-cycle-ceiling` event was emitted for that node.
- **Concrete kill mutation:** revert Step 2 to the old `...(binding.readFixCycles ? {…})` spread (i.e. do NOT supply the default). With the fake binding providing no hooks, `ceilingActive` stays false, the node is attempted instead of skipped, and the "escalated" line is absent → T2 FAILS. This is exactly the mutation that reproduces the current gap, so T2 is the regression guard for it.

**T3 (precedence — a binding's own port WINS).**
Point the CLI at a NEW fixture binding that exports its OWN `readFixCycles`/`bumpFixCycles` (an in-memory counter with a spy). With `--fix-cycle-ceiling`, assert the binding's spy was consulted and NO default sidecar file was created under `<runDir>/optimize/.fixcycles-*.json`.
- **Kill mutation:** make Step 2 unconditionally use `makeDefaultFixCyclesPort` (ignore the binding hooks). T3's "binding spy consulted / no default file" assertions FAIL.

**T4 (default is NOT materialized without the flag).**
Run the fake binding with NO `--fix-cycle-ceiling`. Assert no `<runDir>/optimize/.fixcycles-*.json` is created (the `policy.fixCycleCeiling !== undefined` gate). Kill mutation: drop the gate so the default is always built → a bump could fire and create the file → T4 FAILS. (Note: without the ceiling, the driver never bumps anyway because `ceilingActive` needs the opt; this test guards that we didn't create a port that a future code path could accidentally bump.)

Add a `bad-two-hooks` consideration only if the Open-Question resolution requires it (partial-hook binding); otherwise skip.

## 7. Consumer & Regression Sweep

- **Existing "OPTIONALITY … ceiling inert" test (`optimize-fix-cli.test.ts:154-170`):** currently asserts that with the fake binding + `--fix-cycle-ceiling 3` the CLI "still validates and runs with (ceiling inert)". After this change the ceiling is NO LONGER inert (the default supplies the port). MUST update that test to assert the new correct behavior — the run still succeeds AND, if the node hasn't hit the ceiling, it is attempted normally (ceiling active but not tripped), rather than asserting inertness. Do NOT delete the test to make it pass (test-discipline); rewrite its assertion to the new contract.
- **`makeFixGateRunner` callers:** both `runOptimizeFixCli` (`optimize-fix.ts:226`) and `optimize-loop.ts:132` — verified both go through the same fn, so the fix reaches the multi-round path with no separate edit. Add a note-level assertion in the loop test only if convenient (not required — same code path).
- **Backward-compat with game-omni:** its `binding-live.mjs` exports both hooks (`scope.mjs` port), so precedence (Step 2) keeps using game-omni's port; the delta-0 gs01 dry-validation is unaffected.
- **Core tests untouched** — no core signature changes (`optimize-fix-cycle.test.ts`, `optimize-driver-events.test.ts` still green).

## 8. Rollback & Boundaries

Single-file impl (`optimize-fix.ts`) + its test + a one-line index export. Rollback = revert Step 2 to the two original spread lines and delete `makeDefaultFixCyclesPort`. No migration, no schema, no core change, no live-file mutation. The sidecar is disposable per-run scratch under `<runDir>/optimize/`.

## 9. Self-Check (author, pre-return)

- (a) All 9 bar sections present and substantive. ✅
- (b) Every named file was READ this run: `driver.ts`, `optimize-fix.ts`, `optimize-loop.ts`, `index.ts`, `optimize-fix-cli.test.ts`, `optimize-fix-cycle.test.ts` refs, game-omni `scope.mjs`/`binding-live.mjs`/`fixcycles-port.test.mjs`, `fake-binding.mjs`. No invented signatures (`makeFixGateRunner`, `FixGatePolicy`, `runFixGate` opt/stage shapes all quoted from source). ✅
- (c) Load-bearing tests (T1 round-trip, T2 wiring-activation) each have a concrete kill mutation that reproduces the real gap. ✅
- (d) No invariant violated: no model/network in core; core contract unchanged; counter is per-run bookkeeping, not a live-file fix-land; default gated behind the explicit `--fix-cycle-ceiling` request. ✅

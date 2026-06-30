# Wiring design — G2: concurrency cap / process pool

> Status: DESIGN ONLY (no source edited). Created 2026-06-25. Every existing-code claim cites a
> `file:line` read in `@piflow/core` at this commit. Competitor evidence cites
> `vendor/pi-dynamic-workflows/...`. Framing: `docs/specs/competitive-gaps-vs-pi-dynamic-workflows.md`
> §G2 (lines 125–139).

## 1. Objective

Bound how many headless `pi` OS processes a stage may spawn at once (and, optionally, run-wide), with a
configurable `maxConcurrent` and an optional total-node ceiling — replacing today's UNBOUNDED stage
fan-out, which forks one real `pi` per node with no limit.

## 2. Current state (the unbounded loop + its retry/watchdog/checkpoint context)

- **Unbounded stage fan-out.** `packages/core/src/runner/runner.ts:1017`:
  `const results = await Promise.all(s.nodeIds.map((id) => runNodeWithRetries(ctx, wf.nodes[id], scope)));`
  Every node in the stage is launched in the same tick — no semaphore, no pool. A 50-node stage spawns
  50 `pi` children at once (a latent fork-bomb, worse than the competitor's in-memory sessions).
- **The per-node run fn it maps over** is `runNodeWithRetries(ctx, node, scope)`
  (`runner.ts:479`). It wraps `runNode` (`runner.ts:488`) with the per-node retry budget
  (`io.retries`): first attempt + up to `retries` more while the verdict is `error`/`blocked`
  (`runner.ts:480-485`). It ALWAYS resolves to a `NodeStatusRecord` and NEVER rejects (lane isolation,
  `runner.ts:511-516`) — a sandbox-create throw is caught and turned into an `error` record
  (`runner.ts:557-559`), so a thrown lane can never fail-fast the `Promise.all`.
- **The real OS-process spawn** happens one level deeper, inside `runNode`, at the exec seam:
  `await ctx.execRunner(execSandbox, cmd, { ...ctx.watchdog, nodeTimeoutMs })` (`runner.ts:634`). The
  default `ExecRunner` (`runner.ts:200`) races `sandbox.exec` against a node-timeout + silent-stall
  watchdog and aborts via an `AbortController` on a trip (`runner.ts:215-223`). `sandbox.exec` is the
  actual `spawn` (e.g. worktree provider `sandbox/worktree.ts:120-166`; local `sandbox/local.ts`).
- **Watchdog knobs** live on `ctx.watchdog` (`runner.ts:909-913`): `nodeTimeoutMs` (default
  `1_800_000`), `stallMs` (default `0`), `killGraceMs` (default `3000`). A per-node override is
  `node.sandbox.timeoutMs ?? ctx.watchdog.nodeTimeoutMs` (`runner.ts:629`).
- **Halt-on-error.** After the stage's `Promise.all` resolves, the run halts if any lane is
  `error`/`blocked`: `if (results.some((r) => r.status === 'error' || r.status === 'blocked')) halted = true;`
  (`runner.ts:1041`). The stage loop guard is `for (let i = 0; i < selected.length && !halted; i++)`
  (`runner.ts:1011`).
- **RunState checkpoint** is the stage-barrier merge + persist: `ctx.runState = barrierMerge(...)` then
  `await persistState(outDir, ctx.runState)` (`runner.ts:1028-1029`). Status JSON is written
  throughout via `writeStatus` (e.g. `runner.ts:1014`, and per-node in `finishNode` `runner.ts:850`).
- **No limiter dependency exists.** `packages/core/package.json` dependencies are only `@daytona/sdk`
  and `esbuild` (`package.json:31-34`) — no `p-limit`/`p-queue`/semaphore. A repo-wide grep for
  `p-limit|Semaphore|createLimiter|maxConcurrent|hardwareConcurrency|os.cpus` in
  `packages/core/src` returns NOTHING (no existing util to reuse). So a tiny limiter must be added.

## 3. Reference (competitor) — the limiter pattern

- **The limiter primitive** — `createLimiter(limit)` (`vendor/pi-dynamic-workflows/src/workflow.ts:1008-1024`):
  a counting semaphore with an FIFO wait queue. `active >= limit` ⇒ the caller awaits a queued
  `resolve`; `next()` (the `finally`) decrements and shifts the queue. Zero deps, ~15 lines.
- **Concurrency normalization** (`workflow.ts:284-286`, `normalizeConcurrency` `:1085-1088`):
  `options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2)`, then
  clamped to `[1, MAX_CONCURRENCY]` (`MAX_CONCURRENCY = 16`, `config.ts:12`). **This is the
  `hardwareConcurrency - 2` derivation §G2 references.**
- **The SHARED limiter held across nested runs** (`workflow.ts:288-295`): the limiter +
  `agentCount` + budget live on one `SharedRuntime` object, reused by a nested `workflow()`
  (`workflow.ts:618-621` passes `sharedRuntime: shared`) so caps hold ACROSS nesting.
- **Per-call gating**: every `agent()` body runs inside `return limiter(async () => { ... })`
  (`workflow.ts:419`), and the call FIRST checks the total cap synchronously —
  `if (shared.agentCount >= maxAgents) throw AGENT_LIMIT_EXCEEDED` (`workflow.ts:331-337`,
  `MAX_AGENTS_PER_RUN = 1000`, `config.ts:6`) — with the slot reserved atomically before any await
  (`shared.agentCount++`, `workflow.ts:399`).

### ADOPT vs REJECT (given our one-real-`pi`-per-node, OS-process model)

| Element | Verdict | Why |
|---|---|---|
| `createLimiter` counting-semaphore shape (FIFO queue, `finally`-release) | **ADOPT** | Zero-dep, ~15 lines, framework-agnostic; gates async work regardless of what the work IS (a `spawn` vs an in-memory session). Fits our no-new-dep constraint (`package.json:31-34`). |
| `hardwareConcurrency - 2`, clamped, default | **ADOPT (adapted)** | A CPU-derived default is right. But we gate OS PROCESSES, so derive from `os.cpus().length` (Node has no `navigator`; confirmed unused in `packages/core/src`), not `globalThis.navigator?.hardwareConcurrency`. Keep `Math.max(1, n - 2)`; clamp to a `MAX_CONCURRENT` ceiling. |
| Run-wide total cap (`MAX_AGENTS_PER_RUN`, throw on exceed) | **ADOPT (adapted)** | Maps to a total spawned-node ceiling. Adapt the FAILURE to OUR convention: a synthetic halting node (§5), not a thrown `WorkflowError` — our lanes never reject (`runner.ts:511-516`). |
| Limiter wrapping each `agent()` body | **ADOPT (adapted)** | We wrap each `runNodeWithRetries` call in the stage map (§4), the structural equal of their per-`agent()` wrap. |
| Shared-across-nesting `SharedRuntime` | **REJECT (not applicable yet)** | We have no nested sub-workflows (§G9 is unbuilt — gap doc lines 239–250). One run = one limiter. Revisit if/when sub-DAG inlining lands. |
| In-memory-session specifics (`tokenBudget` accrual, `vm` determinism prelude, journal hashing) | **REJECT** | Bound to their in-process scripting model; irrelevant to a process-per-node DAG. |
| `globalThis.navigator` source | **REJECT** | Browser-ism; Node-side use `os.cpus()`. |

## 4. Design

### 4.1 The limiter util — where it lives, its shape

New file **`packages/core/src/runner/limit.ts`** (next to `runner.ts`; runner-internal, no new dep):

```ts
/** A counting semaphore (FIFO). `limit(fn)` runs `fn` once a slot is free; releases on settle. */
export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

export function createLimiter(limit: number): Limiter {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => { active--; queue.shift()?.(); };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((r) => queue.push(r));
    active++;
    try { return await fn(); } finally { next(); }
  };
}
```

This is the competitor's shape (`workflow.ts:1008-1024`) verbatim-in-spirit, typed and de-coupled.
A `limit <= 0` is normalized by the caller (§4.4) to `>= 1`, so the constructor needs no guard.

> Note: the release MUST be in a `finally` so a node lane that rejects still frees its slot — but our
> lanes never reject (`runner.ts:511-516`), so in practice every `fn` resolves; the `finally` is
> defense-in-depth.

### 4.2 RunOptions knobs + CLI flag

Add to the `RunOptions` interface (`runner.ts:85-183`, alongside `nodeTimeoutMs`/`stallMs` at
`:126-131`):

```ts
/** Max concurrent node processes IN-FLIGHT (per stage and run-wide; see design). Default ~ os.cpus()-2, clamped to MAX_CONCURRENT. */
maxConcurrent?: number;
/** Run-wide ceiling on TOTAL nodes spawned; exceeding HALTS the run (synthetic __concurrency__ node). Omit ⇒ no total cap. */
maxNodesPerRun?: number;
```

Two module constants in `runner.ts` (mirroring the competitor's `config.ts`):
`const MAX_CONCURRENT = 16;` (ceiling) and NO default for `maxNodesPerRun` (opt-in; the competitor's
1000 is their default, but ours is a safety valve the operator chooses).

**Threading path (already a real path — no plumbing invented):**

- `RunFromTemplateOpts extends RunOptions` (`runner/entry.ts:66`) and `runFromTemplate` forwards
  `{ ...runOpts, outDir, workspace }` into `runWorkflow` (`entry.ts:94`). A new `RunOptions` field
  flows through automatically.
- `ResolvedRunConfig = RunOptions & {...spec source}` (`entry.ts:25`); `runFromConfig` spreads
  `runOpts` into `runWorkflow` (`entry.ts:57`). Also automatic.
- **CLI**: `ParsedRunArgs` (`packages/cli/src/run.ts:82-103`) gains `maxConcurrent?: number`; parse a
  `--max-concurrent` flag in `parseRunArgs` (`run.ts:106-130`, sibling to `--sandbox`/`--from`/`--until`
  at `:117-120`) via `Number(argv[++i])`; pass it in the `runFromTemplate(...)` call object
  (`run.ts:243-259`, alongside `from`/`until`/`thinking`). `--max-nodes` similarly if exposed.
- **Optional env** (only if a `PI_RUNNER_*` knob is wanted): add `maxConcurrent` to `ConfigArgs` +
  the `ResolvedRunOpts` `Pick` (`runner/config.ts:51-65`) and resolve
  `args.maxConcurrent ?? Number(env.PI_RUNNER_MAX_CONCURRENT)` in `loadConfig` (`config.ts:113-128`),
  mirroring `nodeTimeoutMs`. **Defer unless asked** — the CLI flag + RunOptions cover the live path.

### 4.3 The EXACT insertion point (stage loop)

One construction site (the limiter) + one wrap site (the stage map). Pseudo-diff against
`runner.ts:880-1017`:

**Construct the limiter once, in `runWorkflow`, on `ctx`** (after `ctx` is built, near `runner.ts:887`;
or store `maxConcurrent`/`maxNodesPerRun`/a `spawned` counter on `ctx`). Add to `RunContext`
(`runner.ts:377-416`): `limiter: Limiter; maxNodesPerRun?: number; spawnedNodes: { n: number };`

```diff
  // in runWorkflow, building ctx:
+ const maxConcurrent = normalizeConcurrent(opts.maxConcurrent);   // §4.4
  const ctx: RunContext = {
    ...
+   limiter: createLimiter(maxConcurrent),
+   maxNodesPerRun: opts.maxNodesPerRun,
+   spawnedNodes: { n: 0 },
  };
```

**Wrap the stage map** (`runner.ts:1017`) — the cap is enforced HERE, around the WHOLE
`runNodeWithRetries` call (so retries share ONE slot — see §4.5):

```diff
- const results = await Promise.all(
-   s.nodeIds.map((id) => runNodeWithRetries(ctx, wf.nodes[id], scope)),
- );
+ const results = await Promise.all(
+   s.nodeIds.map((id) =>
+     ctx.limiter(async () => {
+       // run-wide total ceiling: count each node ONCE as it acquires a slot.
+       if (ctx.maxNodesPerRun !== undefined && ctx.spawnedNodes.n >= ctx.maxNodesPerRun) {
+         return cappedRecord(ctx, id);   // synthetic 'error' record — drives halt (§5)
+       }
+       ctx.spawnedNodes.n++;
+       return runNodeWithRetries(ctx, wf.nodes[id], scope);
+     }),
+   ),
+ );
```

Everything downstream of the wrap is UNCHANGED: each lane still resolves to a `NodeStatusRecord`, the
barrier merge (`runner.ts:1019-1038`) and halt check (`runner.ts:1041`) read `results` exactly as
before. The limiter only DELAYS when a lane STARTS; it changes nothing about how a lane ENDS.

`cappedRecord(ctx, id)` writes a node `error` record into `ctx.status.nodes[id]` (via the same
`finishNode`/`writeStatus` machinery, or inline like the `__resume__` synthetic at `runner.ts:981-984`)
with issue `total node cap (maxNodesPerRun=N) exceeded` — and because it is `error`, the existing
`results.some(... 'error')` halt at `runner.ts:1041` stops the run. (See §8 open decision: error-vs-drop.)

### 4.4 Default derivation

New helper in `limit.ts` (Node-side, `os.cpus()` not `navigator` — confirmed `navigator` is unused in
`packages/core/src`):

```ts
import { cpus } from 'node:os';
export function normalizeConcurrent(value: number | undefined, max = 16): number {
  const fallback = Math.max(1, cpus().length - 2);          // the §G2 'hardwareConcurrency - 2' rule
  const n = value === undefined ? fallback : value;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(max, Math.floor(n));
}
```

So: explicit `maxConcurrent` wins; else `cpus().length - 2` (min 1); always clamped to `[1, 16]`.
Rationale for clamping low and CPU-derived: each node is a REAL `pi` process (the gap doc's whole
point, lines 132–134) — overflow is heavier than the competitor's sessions, so the ceiling is a hard
safety valve, not a throughput knob.

### 4.5 How it composes with retries / watchdog / halt / checkpoint

- **Retries**: the wrap is OUTSIDE `runNodeWithRetries`, so all attempts of one node share ONE slot
  (`runner.ts:480-485` loops `runNode` in-place). The pool counts NODES in flight, not attempts —
  correct: a retrying node is still one `pi` process at a time, and it must not release+re-acquire
  between attempts (that would let the pool overshoot during a retry storm).
- **Watchdog / timeout**: untouched. The slot is held for the node's whole lifetime incl. the
  `ctx.execRunner` watchdog race (`runner.ts:634`); when a watchdog trip kills the child and the lane
  resolves to `error`, the limiter's `finally` (`limit.ts`) releases the slot, admitting the next
  queued node. The cap NEVER interferes with kill/timeout — it only governs admission.
- **Halt**: unchanged. Halt is still decided post-`Promise.all` at `runner.ts:1041`. A capped stage
  finishes the in-flight + queued lanes, then halts if any is `error`/`blocked`. The total-cap
  synthetic record (§4.3) is itself `error`, so it routes through the SAME halt.
- **Checkpoint (RunState)**: unchanged. The barrier merge/persist (`runner.ts:1028-1029`) runs AFTER
  the stage's `Promise.all` settles — the limiter has fully drained by then, so the checkpoint sees
  the same complete `results`/`promotesByNode` it does today.
- **Sandbox run-scope**: unchanged. `scope` is opened ONCE per run (`runner.ts:996`) before the stage
  loop; the limiter does not touch it (see §5 sandbox note).

## 5. Edge cases & failure modes

1. **A node errors while siblings are mid-flight.** The limiter only delays START; an erroring lane
   resolves to an `error` record (never rejects — `runner.ts:511-516`), its `finally` frees the slot,
   queued lanes proceed, and the stage halts AFTER `Promise.all` at `runner.ts:1041` exactly as today.
   No change to fail-behavior; we are strictly safer (fewer concurrent children).
2. **Abort / SIGTERM under a cap.** Kill is per-node, owned by the watchdog → `AbortController`
   (`runner.ts:215-223`) → the provider's process-group `SIGTERM→SIGKILL` (`sandbox/worktree.ts:138-144`).
   The limiter is orthogonal: a killed node's lane resolves, releasing its slot. **Risk to verify**:
   if a node is QUEUED (not yet started) when the run is tearing down, it will still start when a slot
   frees — there is no run-level abort signal threaded into the stage map today, so the cap does not
   make this worse, but the test plan (§6) asserts the pool never exceeds the limit even as kills
   recycle slots.
3. **Stage smaller than the cap** (`nodeIds.length <= maxConcurrent`). The limiter admits all of them
   immediately — byte-identical to today's unbounded `Promise.all`. No regression on the common case
   (most stages are 1–3 nodes; the cap is inert there).
4. **Interaction with sandbox setup cost.** The run scope is PER-RUN, opened once (`runner.ts:996`,
   `openRunScope` `runner.ts:863`): the worktree is created once for the whole run
   (`sandbox/worktree.ts:266-312` — one branch/checkout spans all nodes), and daytona boots ONE VM per
   run (`sandbox/daytona.ts:507`). The PER-NODE cost is `scope.create` (a `WorktreeSandbox` workdir
   mkdir, `sandbox/worktree.ts:93-98`; a daytona `createFolder` view). So the cap throttles per-node
   sandbox creates, NOT the expensive per-run boot — correct: we never want to serialize the one-time
   worktree/VM setup, and we never do (it is outside the loop). The cap is purely about how many `pi`
   children run concurrently inside the already-set-up scope. **The local/inmemory providers have no
   shared resource** (`sandbox/local.ts` openRun is trivial; `runner.ts:865-869`), so the cap is the
   only thing bounding real `spawn` count there — which is exactly the fork-bomb §G2 targets.
5. **`maxConcurrent` larger than the stage.** Inert (see #3). `maxConcurrent` smaller than 1 / NaN →
   normalized to 1 (`normalizeConcurrent`, §4.4) — a single explicit `--max-concurrent 0` degrades to
   serial, never to "unbounded" or "deadlocked".
6. **Total cap mid-stage.** Because we count at slot-acquire (§4.3), the Nth-over-limit node in a wide
   stage gets a synthetic `error` and the run halts at the stage boundary — deterministic, no partial
   torn state (the barrier still runs on whatever completed). See §8 for error-vs-drop.

## 6. Test plan (each FAILS on a broken cap)

The observable seam is the **`execRunner`** (the per-node spawn primitive, `RunOptions.execRunner`,
`runner.ts:117`) — inject a counting stub and assert PEAK concurrency. This is the right seam because
the limiter wraps `runNodeWithRetries` (`runner.ts:1017`), and `execRunner` is the deepest point each
node passes through exactly once per attempt (`runner.ts:634`); a broken/removed cap makes peak exceed
the limit here.

- **T1 — peak concurrency never exceeds the cap.** Build a workflow with a single stage of 5
  independent nodes (no `io.reads` edges between them, so `compile` puts them in ONE stage). Inject an
  `execRunner` that increments a shared `inFlight` counter on entry, `await`s a manually-released
  deferred (so all admitted lanes pile up), records `peak = max(peak, inFlight)`, decrements on exit.
  Run with `maxConcurrent: 2`. **Assert `peak === 2`.** With the cap removed/broken, `peak === 5` →
  the test FAILS. (This is the named-seam, must-fail test §G2 wants.)
- **T2 — FIFO admission, full drain.** Same harness; release deferreds one at a time and assert exactly
  one queued lane is admitted per release, and all 5 nodes eventually run (`ctx.status.nodes` all
  terminal). Fails if the limiter dead-queues (never releases) or admits out of order.
- **T3 — retries share one slot.** A 3-node stage, `maxConcurrent: 1`, one node with `io.retries: 2`
  whose `execRunner` returns `code:1` (→ `error` → retried). Assert peak `inFlight === 1` ACROSS the
  retries (the retrying node never overlaps a sibling). Fails if the wrap is inside
  `runNodeWithRetries` instead of around it (slot released between attempts).
- **T4 — total node cap halts.** A 2-stage workflow, `maxNodesPerRun: 1`. Assert the run ends
  `done && ok === false`, node 2 has a `total node cap ... exceeded` issue, and node 2's `execRunner`
  was NEVER called (`spawn` count === 1). Fails if the total cap is unenforced (both spawn) or silently
  drops without halting.
- **T5 — small stage is inert.** A 2-node stage, `maxConcurrent: 16`. Assert both run concurrently
  (peak 2) and the result is byte-identical to a no-`maxConcurrent` run. Fails if the limiter
  accidentally serializes under-cap stages.
- **T6 — default derivation is clamped & CPU-derived.** Unit-test `normalizeConcurrent`:
  `undefined → max(1, cpus().length-2)` clamped to ≤16; `0/NaN/-5 → 1`; `100 → 16`; `3 → 3`. Fails if
  the default is uncapped or the floor is wrong. (Pure function — no spawn.)

No coverage-only tests: every test above asserts an OBSERVABLE behavior (peak count, halt verdict,
spawn-call count) that flips when the cap is wrong.

## 7. Files to touch (complete + minimal)

| Path | Change | Size |
|---|---|---|
| `packages/core/src/runner/limit.ts` | **NEW** — `createLimiter` + `normalizeConcurrent` + types | ~30 lines |
| `packages/core/src/runner/runner.ts` | `RunOptions`: add `maxConcurrent`/`maxNodesPerRun` (`:85-183`); `RunContext`: add `limiter`/`maxNodesPerRun`/`spawnedNodes` (`:377-416`); construct limiter + `MAX_CONCURRENT` const (`~:887`); WRAP the stage map + synthetic cap record (`:1017`); import from `./limit.js` | ~25 lines |
| `packages/core/src/index.ts` | export `createLimiter`/`normalizeConcurrent` IF a consumer/test needs them at the root (mirrors how `buildRunView` was surfaced); else skip | ~1 line |
| `packages/cli/src/run.ts` | `ParsedRunArgs.maxConcurrent` (`:82-103`); parse `--max-concurrent` (`:106-130`); pass into `runFromTemplate(...)` (`:243-259`) | ~4 lines |
| `packages/core/src/runner/config.ts` | OPTIONAL env knob: add `maxConcurrent` to `ConfigArgs` + `ResolvedRunOpts` Pick (`:51-65`) + resolve `PI_RUNNER_MAX_CONCURRENT` (`:113-128`) | ~5 lines — DEFER unless env support is requested |
| `packages/core/test/...` (runner test dir) | T1–T6 (§6) | ~120 lines |

`NodeSpec`/templates/schema/loader are NOT touched: `maxConcurrent` is a RUN-level knob, not per-node
(unlike G1 model routing). No `package.json` change — zero new deps (confirmed `package.json:31-34`).

## 8. Open decisions (need the human's call)

1. **Per-stage vs global limiter.** RECOMMENDED: **one global limiter** for the whole run (constructed
   once on `ctx`). Justification: stages run SEQUENTIALLY (`runner.ts:1011`, one stage's `Promise.all`
   fully settles before the next), so a per-stage limiter and a global one cap the SAME in-flight set at
   any instant — there is never cross-stage overlap to bound. A global limiter is simpler and is the
   natural home for the run-wide total cap. (A per-stage cap would only differ if stages overlapped,
   which they don't.) Confirm.
2. **Default value.** RECOMMENDED `max(1, os.cpus()-2)` clamped to `[1, 16]` (matches the competitor's
   intent, adapted to OS processes). Confirm the ceiling (16) and whether the default should be LOWER
   for process-per-node (e.g. clamp to 8) given each node is a full `pi` + sandbox.
3. **Total-cap behavior: error-and-halt vs log-and-drop.** RECOMMENDED **error-and-halt** via a
   synthetic `error` record (matches piflow's loud-failure convention — `__resume__`/`__barrier__`/
   `__runscope__` synthetics at `runner.ts:981,1001,1031`, all of which set `ok:false`). "Log-and-drop"
   would silently skip nodes, contradicting the "verified, not trusted / fail loudly" spine. Confirm —
   the only argument for drop is if a total cap is meant as a soft budget, which §G2 frames as a safety
   ceiling (a fork-bomb guard), favoring halt.
4. **Expose `maxNodesPerRun` at all in M-now?** It is opt-in (omit ⇒ no total cap). Ship it, or land
   `maxConcurrent` alone first and add the total cap later? (The total cap is the cheaper safety net but
   the per-stage `maxConcurrent` already defuses the fork-bomb.)

## ⚠️ Discrepancies vs the brief's cited lines (verified by reading)

- The unbounded `Promise.all(s.nodeIds.map(runNodeWithRetries))` is at **`runner.ts:1017`**, not `~1014`
  (line 1014 is the preceding `await writeStatus(...)`). The mapped closure passes
  `runNodeWithRetries(ctx, wf.nodes[id], scope)` (3 args), not a bare `runNodeWithRetries` reference.
- The RunState checkpoint (persist) is at **`runner.ts:1028-1029`** (`barrierMerge` + `persistState`),
  not `~1026` (line 1026 is the `if (updates.length)` guard).
- Retry wrapper is at `runner.ts:479` ✓ and the exec/watchdog seam at `runner.ts:634` (the brief's
  `~629` is the `nodeTimeoutMs` line that FEEDS that call — both correct, adjacent).
- Competitor `createLimiter` is `workflow.ts:1008-1024` ✓; the shared-limiter normalization is
  `:284-295` ✓; caps in `config.ts` (`MAX_CONCURRENCY=16` `:12`, `MAX_AGENTS_PER_RUN=1000` `:6`) ✓.

## Self-check (Required bar)

1. **Every existing-code claim cites a read file:line.** PASS — §2/§3/§4/§5/§7 cite runner.ts,
   entry.ts, config.ts, run.ts, worktree.ts, local.ts, daytona.ts, package.json, types.ts lines all
   read this session; the off-by-a-few brief lines are corrected in ⚠️ Discrepancies.
2. **Insertion point names the real fn + shows retry/watchdog/halt survive.** PASS — wraps
   `runNodeWithRetries` at `runner.ts:1017` OUTSIDE the retry loop (§4.5), slot held across the
   watchdog race (`runner.ts:634`), halt still decided at `runner.ts:1041`.
3. **Works for OS-process nodes, not an in-memory-session copy.** PASS — REJECT table drops the
   session-specific bits; `os.cpus()` not `navigator`; the cap throttles `scope.create`+`spawn`, not
   the per-run worktree/VM boot (§5.4).
4. **Test plan names an observable seam that FAILS on a broken cap.** PASS — T1 instruments the
   injected `execRunner` (`RunOptions.execRunner`, `runner.ts:117`) and asserts `peak === 2` for
   `maxConcurrent:2` over a 5-node stage; `peak===5` when the cap is broken.
5. **Files-to-touch is complete + minimal.** PASS — one new file + runner.ts + cli/run.ts (core path),
   tests, optional config.ts/index.ts marked DEFER/IF-needed; no template/schema/package.json churn.

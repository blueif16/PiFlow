# Per-node `fullAccess` — a node-level "skip the read-write jail" flag

**Date:** 2026-06-29 · **Branch:** `worktree-feat+per-node-sandbox-mirror` · **Status:** design, ready to build
· **Supersedes the reverted skin work** (the run-level `sandboxChoice` field, removed `e2bb463` — see §6).

> One line: a node can opt out of its filesystem jail (`fullAccess: true`) — a **local-only**, **loosen-only**,
> per-node posture. It rides the **existing** node-config mirror, so the GUI skin is a ~4-line render off config,
> not a field threaded through core for the skin's sake.

---

## 1. The principle this is built on (the correction that produced it)

**Node config is the ground truth. A skin is only a projection of config — never a reason to add data.**

The earlier attempt added a run-level field (`sandboxChoice`) threaded through core → observe → CLI *purely so
the GUI could draw a third color*. That inverted the dependency: a presentation distinction drove a data-model
change, and produced a duplicate of the existing `sandbox` field. It was reverted.

`fullAccess` is the opposite shape: it is a **real per-node execution knob** (it changes how the node runs), so
it earns a place in the node config on its own merits. The config already flows to the GUI via the
`NodeConfig` mirror (`runner/status.ts` → `observe/runView.ts` → `gui`). The skin therefore reads config that is
**already there for execution reasons**. No new channel. No duplicate field.

**Rule for any future skin/badge:** if the data you need to render a state is not already in the node config for
a real execution reason, the default is to **drop the visual**, not to add plumbing to carry it.

## 2. What `fullAccess` means (and explicitly does not)

`--sandbox local` runs each node's `pi` inside a kernel jail (seatbelt on darwin / bwrap on linux) bounded to the
node's declared `readScope` + `owns` + toolchain (`sandbox/local.ts` — `enforceReadScope`, consumed in `exec` at
`local.ts:126` via `localJailPlan`). `fullAccess: true` turns **that jail off for one node** — its `pi` reads and
writes the whole host filesystem (the per-node equivalent of the run-level `--sandbox danger-full-access`).

- **Local-only.** A jail only exists on a local run. In a cloud VM the VM *is* the isolation boundary and the
  agent already has full access inside it — there is nothing to skip. On a cloud run `fullAccess` is a **no-op**
  (record it, ignore it; a load-time WARN is fine, never an error). It does **not** force a run local.
- **Loosen-only.** `fullAccess` removes the jail; it never tightens. There is no per-node "stay jailed inside a
  danger run" knob (YAGNI).
- **It nullifies only the read-write scoping.** When set, `readScope`/`owns` become moot for that node. It does
  **not** touch model, tools, timeout, retries, or the backend — it is one switch on one axis (the fs jail).

## 3. Reconciling the `programmatic` node — the unified jail decision

A `programmatic` node already runs **unsandboxed on the host** (`types.ts:91-94`: host `spawnSync`, jail ignored,
always local) — it is a *separate lane* (`runner/node-lanes.ts:234`) that never calls `scope.create`. A
`fullAccess` pi node reaches the jail seam (`scope.create` → `LocalSandbox.exec`) and turns it off. So the two
"unjailed" cases share a **concept** but NOT a call site:

- `programmatic` → unjailed because the command is fixed + repo-authored (**no LLM to contain** → safe).
- `fullAccess` → unjailed because the author explicitly opted an **LLM** out of the jail (an opt-in posture).

The "robust basis" is that this is ONE coherent model — *unjailed = programmatic ∨ fullAccess* — and the config
records both (`programmatic` and `fullAccess` slices) so a viewer reasons about them together. **Do NOT add a
`nodeIsUnjailed` helper unless it has a real consumer** (programmatic and `fullAccess` go through different code
paths, so a shared predicate would be dead code today). The concrete "adaptation" is: (a) `fullAccess` threads
the jail override at `scope.create`; (b) both flags land in `NodeConfig`; (c) a comment at the programmatic
handling site names it the no-LLM sibling of `fullAccess`. Programmatic *execution* is unchanged.

## 4. The skin — three modes, a pure projection of config (~4 lines)

```ts
// gui/src/data/runView.ts — reads node config only; no run-level field.
function nodeSkin(view, node): "flat" | "cloud" | "unlocked" {
  if (CLOUD.has(view.sandbox)) return "cloud";        // ran in daytona/e2b → the extruded block (exists today)
  if (node.config?.fullAccess)  return "unlocked";     // jail off → a small open-padlock glyph (see below)
  return "flat";                                        // local, jailed — incl. programmatic (safe/deterministic)
}
```

**The `unlocked` treatment is NEUTRAL, not an alarm.** Render a **small open-padlock (unlock) glyph** in the node
header — same recessive pattern as the existing `CloudGlyph` — with aria text like "sandbox unlocked — full
filesystem access". It signals "we unlocked this node's sandbox", which is **not inherently bad**, just informative.
So: a small unlock glyph, a **neutral/muted color** (e.g. `--ds-text-tertiary`/`--ds-text-secondary`), and **no
loud red wash** (do NOT use `--ds-error` or a danger tint — the earlier `danger`/red treatment is dropped). Keep
it very small.

**DECISION (programmatic stays flat).** A programmatic node is also unjailed, but it renders **flat** — it never
unlocked a sandbox (it has none; it runs a fixed, no-LLM command). The unlock glyph is for a `fullAccess` *pi*
node (an LLM whose jail was opened). (If product later wants programmatic marked, give it its OWN marker.)

The skin is cosmetic and ≤5 lines; it is the LAST thing built and the least important. Config is the reason.

## 5. The build — exact seams (this is the contract)

All additive/optional; a node without `fullAccess` behaves exactly as today.

**Core (`packages/core`):**
1. `src/types.ts` — `SandboxSpec` gains `fullAccess?: boolean` (the authored flag; sits with `read`/`write`).
   `CreateOpts` gains `enforceReadScope?: boolean` (the per-node jail override; document: `false` ⇒ jail off).
2. (only if it has a real consumer) a `nodeIsUnjailed(node)` helper — see §3; SKIP it if no shared call site
   exists (no dead code). Instead, comment the programmatic handling site as the no-LLM sibling of `fullAccess`.
3. `src/sandbox/local.ts` — `LocalSandboxProvider.create(opts)` (currently `:259`) honors a per-node override:
   `LocalSandbox.create(opts, { enforceReadScope: opts.enforceReadScope ?? this.enforceReadScope })`. Per-node
   `false` wins; absent ⇒ inherit the run-level provider policy. (InMemory/cloud providers ignore the field.)
4. `src/runner/node-lifecycle.ts` — at `scope.create({...})` (`:200`) pass
   `enforceReadScope: node.sandbox?.fullAccess ? false : undefined` (only a `fullAccess` node overrides).
5. `src/runner/status.ts` — `NodeConfig` gains `fullAccess?: boolean` (top-level, parallels `programmatic`).
6. `src/runner/node-lifecycle.ts` — `buildNodeConfig` (`:762`) sets `cfg.fullAccess = true` when
   `node.sandbox?.fullAccess === true` (OMITTED when false/absent — the slice stays minimal, like every field).
7. `src/workflow/template/schema/node.schema.ts` — allow `sandbox.fullAccess` (boolean) in the authoring schema
   so a `node.json` may declare it and the §8 loader gate accepts it.
8. `src/observe/runView.ts` — **no change needed**: `NodeConfig` already round-trips verbatim through
   `buildRunView` (observe.test.ts already pins this). Confirm `fullAccess` rides it (it will, via the slice).

**GUI (`gui`):** re-introduce the 3-mode skin, now **config-driven** (reads `node.config.fullAccess`, NOT a
run-level field): `sandboxSkin`/`nodeSkin` per §4 + the red `danger` render in `WorkflowNode.tsx` + the
`--ds-danger-tint` token + glyph. (The reverted commit `f903c87` is a reference for the render/CSS only — but its
*data wiring was wrong*; wire to config this time.)

## 6. Out of scope (do NOT build — these are the traps)

- **Per-node backend mixing** (node X→cloud while node Y→local in one run) — the LOCKED-deferred decision. This
  feature is per-node *jail posture*, all within one local run; it does NOT mix backends.
- **Run-level `--sandbox danger-full-access` → the skin.** Do NOT thread the run-level danger choice to the skin
  (that was the reverted mistake). Under a run-level danger run, nodes render by their own config only. (A future
  option — fold the provider's effective jail state into each node's `NodeConfig.fullAccess` at stamp time, so a
  danger run colors all nodes — is a deliberate later call, NOT this cut; it needs the provider to expose its
  jail state, which the `SandboxProvider` interface does not today.)
- **Per-node tightening** (stay-jailed-in-a-danger-run) — YAGNI.
- **Cloud `fullAccess`** — a no-op by definition; record + ignore (optional WARN), never error, never special-case.

## 7. Tests (test-first; a test must FAIL when the code is wrong)

- **Core — the jail override (the load-bearing one):** a `LocalSandbox` created with `enforceReadScope:false`
  runs the command BARE (no `localJailPlan`); with `true`/default it wraps. Pin via the existing
  `packages/core/test/sandbox-local.test.ts` harness (it already exercises the jail on/off — `:465`). New case:
  the override flows from `CreateOpts.enforceReadScope` through the provider.
- **Core — config mapping:** `buildNodeConfig` sets `fullAccess:true` for a `node.sandbox.fullAccess` node and
  OMITS it otherwise. (mirror the existing `programmatic` slice test.)
- **Core — schema:** `node.schema.ts` ACCEPTS `sandbox.fullAccess:true` and the loader round-trips it.
- **GUI — skin mapping:** `nodeSkin` returns `unlocked` for `config.fullAccess`, `cloud` for a cloud backend,
  `flat` otherwise INCLUDING a programmatic node (the programmatic-stays-flat decision, pinned).

## 8. Execution plan (subagents)

Two bounded, mostly-independent units; the main thread integrates + VERIFIES against the diff and test output
(never the agent's self-report):

- **Agent A — core (execution + config + schema):** items §5.1–§5.7 + the §7 core/schema tests, test-first.
  Tightly-coupled; ONE agent. Scope fence: do NOT touch the GUI; do NOT build anything in §6.
- **Agent B — GUI skin (config-driven):** §5 GUI + the §7 GUI test, test-first. Scope fence: read
  `node.config.fullAccess` ONLY; introduce NO run-level field; do NOT touch core.

Gate before merge: `tsc -b` clean, `packages/core` + `gui` test suites green (modulo the 3 pre-existing
unrelated failures: two empty legacy `.mjs`, one `node-writeback` 400/200), no new `tsc` errors.

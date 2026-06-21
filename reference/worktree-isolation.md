# Worktree isolation (opt-in physical isolation for parallel runs)

When a fleet of runs share ONE working tree, a non-Claude model in run A can wander into run B's files —
read them as "reference", or worse, write into them. The Output Contract (`artifact-contract.md`)
makes the *silent-failure* half loud (a node that produced nothing for its own lane fails as
`blocked`). Worktree isolation closes the other half: it makes the *wander itself impossible* by
giving each run its own full checkout.

## What `--worktree` does

`node pi-runner/run.mjs --run <id> --worktree …` (or `PI_RUNNER_WORKTREE=1`):

1. **Creates a per-run git worktree** — `git worktree add -B pi/<id> <sibling>/.pi-worktrees/<id> HEAD`.
   A full, separate checkout on its own branch, at a sibling dir OUTSIDE the repo (no gitignore, no
   recursion). It starts from committed `HEAD` — a clean room. Uncommitted main-tree changes are
   intentionally absent, so **pass the run's input via `--arg`/`--brief`/`--arg-file`** rather than
   relying on an uncommitted file.
2. **Symlinks `node_modules`** from the main checkout (it is gitignored, so the fresh checkout has
   none) for **every package in the repo** — each tracked `package.json`'s dir (discovered via
   `git ls-files`) plus the repo root and cwd. A multi-package repo (e.g. a `packages/verify`
   harness with its own deps) thus has all its scripts runnable inside the worktree; a single-package
   repo links just root.
3. **Remaps execution** — `ROOT`/`RUN_CWD` (where pi runs + where artifacts resolve) point at the
   worktree. Each node's prompt has the workflow's hardcoded absolute paths rewritten
   `BASE_ROOT→<worktree>` ONCE, so the agent writes INTO the worktree AND the driver's own marker
   checks (`DRIVER-PREFLIGHT` / `DRIVER-ARTIFACTS` / `DRIVER-OWNS`) resolve there too. Paths outside
   the repo (shared kits, etc.) are left untouched.
4. **Keeps status + logs in the MAIN tree** — `out/<id>/run-status.json`, `_pi/*.events.jsonl`,
   prompt files. So `status.mjs` / `watch.mjs` / polling are unaffected and survive teardown.
5. **On finish** — commits the lesson SOURCE to branch `pi/<id>`, copies the deliverable
   `out/<id>/` back to the main tree (it is gitignored, so it would vanish with the worktree), then
   removes the worktree (the branch persists for a human-gated merge). On failure (or
   `--keep-worktree`) the worktree is KEPT for inspection.

## When do you need this? (decision guide)

`--worktree` is **opt-in, and most workflows should NOT use it.** Decide with two questions:

1. **Do you run a concurrent FLEET over ONE working tree?** — N runs at the same time in the same
   checkout, *not* N serialized `--run <id>` runs that each write their own `out/<id>/`. Only a true
   concurrent fleet can cross-contaminate a shared tree.
2. **Do those runs contend on a SHARED MUTABLE file?** — e.g. a hand-edited registration list
   (Remotion's `Root.tsx` `<Composition>` array). Disjoint per-run writes need no isolation.

**Adopt `--worktree` only if BOTH are yes** — then physical isolation earns its merge-back cost
(pair it with auto-discovered registration, below).

**Skip it (the default) when** each run is a single pass to its own gitignored `out/<id>/` (or an
isolated `projectDir`) with no shared mutable file. You already have the isolation that matters:
per-run dirs are separate by construction, and the **Output Contract** (`artifact-contract.md`)
makes silent path-drift a LOUD `blocked` — the *other* half of what isolation buys, without a second
checkout. **First adopter test — game-omni** (one prompt→game pass per `out/<id>`) evaluated this and
**chose NOT to use `--worktree`**: the Output Contract + gitignored per-run dir already gave the
robustness, at zero added code/config.

**GOTCHA if you DO adopt it with a `projectDir`-style workflow.** The remap rewrites only
`BASE_ROOT`-absolute paths *in the prompt text* (`setupWorktree` + the line-~423 rewrite) — never the
non-Claude model's *runtime self-reports*. So a workflow that uses a RELATIVE `projectDir`, or whose model
self-reports project-relative paths, hits false `blocked`: the two driver resolvers disagree
(`artifactState` tries RUN_CWD then ROOT; `artifactStateAbs` does a bare `statSync`), and
`declaredMissing` can override a *satisfied* `DRIVER-ARTIFACTS` contract. Minimal generalizing fix
(do this BEFORE relying on `--worktree` for such a workflow): unify the resolvers (`artifactStateAbs`
forgiving like `artifactState`) and make a satisfied contract suppress the `declaredMissing`
self-report override — i.e. apply "verified, not trusted" correctly.

## Why it needs auto-discovered registration

Worktree isolation's one cost is **merge-back**: N branches that each hand-appended to a shared file
(e.g. a Remotion `Root.tsx` `<Composition>` list) collide on it. The companion change — **auto-discovered
registration** (the composer registers a lesson by exporting a descriptor from its OWN file; a
generated index discovers it; nobody edits the shared list) — makes every per-lesson change a set of
DISJOINT paths. Then merge-back is a conflict-free union:

```
# integrate a finished lesson branch onto main (human-gated):
git checkout main
git merge --no-edit pi/<id>          # disjoint lesson files → no conflict
npm run lessons:registry             # (+ registry:build if the lesson minted a new primitive)
git commit -am "integrate <id>"      # regenerate shared catalogs, don't hand-merge them
```

The generated catalogs (lesson registry, primitive registry) are the only non-disjoint files; they
are **regenerated** on main, never hand-merged — exactly how the primitive registry already behaves
when two lessons both add a primitive.

## Verification status

The git mechanics (create / symlink / teardown), the `--worktree` arg plumbing, the dry-run skip,
and the prompt-rewrite (BASE_ROOT→worktree retargets the contract markers; kit paths untouched) are
verified. **First end-to-end exercise — game-omni, 2026-06-09** — which is what the "mechanics
verified" status had been hiding: it surfaced and FIXED two real bugs on first contact — a **TDZ
startup crash** (`setupWorktree` referenced `ensureDir`/`git` before init; `--worktree` had literally
never run end-to-end — commit `0ce8303`) and **node_modules symlinked only for root+cwd**
(multi-package repos got none — commit `dcae3a0`). It also surfaced the `projectDir` self-report gaps
documented in the decision guide above. game-omni then concluded it did not need the worktree, so
those gaps remain OPEN for the next workflow that genuinely needs `--worktree` with a
relative/`projectDir` layout — fix them first (per the guide) and validate with a real clean-room run.

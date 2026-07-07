# Pi Flow — Linear roadmap binding

> **The roadmap lives IN LINEAR** — goals (Projects), work (Issues), and dependencies (`blockedBy` relations)
> are the single source of truth. This file is **only the pointer + our conventions**, NOT a copy of the DAG.
> The `roadmap` skill (`~/.claude/skills/roadmap/`) is the reusable METHOD; Linear is the record.

## Where the roadmap lives
- Workspace team: **`Ran0216`** (`ee5f10fb-23c2-4112-bbc4-1d576dbfc99f`).
- **Goal 1 — Full end-to-end run** (Project `dfc02b70-e5bf-423f-928f-514a05e0cedb`):
  https://linear.app/ran0216/project/goal-1-full-end-to-end-run-one-complete-loop-d2b53777a621
  - Issues **RAN-11 … RAN-21**; the dependency DAG = their Linear `blockedBy` relations (that IS the DAG — read it in Linear, not here).
- Goal 2 — "optimize the optimization loop" — a sibling Project, later.

## Conventions (per-repo binding)
- Product to run: **game-omni** (`/Users/tk/Desktop/game-omni`). Context: **local** (`--sandbox local`).
- Issue body = **What** / **Acceptance criteria** (falsifiable) / **Source** (link to the upstream `docs/` doc + the `piflowctl understand` slice) / **Deps** (blockedBy + edge basis).
- Edge-basis tags on every `blockedBy`: **a**=artifact/data · **b**=shared-write · **c**=interface-before-consumer · **d**=prefactor.
- Timelines = Linear native fields (`targetDate`, cycles) + re-derived `save_status_update` health; **never duplicated into this file**.
- **Parallel-safety rule (worker fan-out):** worktrees isolate the piflow SDK repo, **not** the shared game-omni tree — so each parallel worker must write a **unique run id / disjoint subtree / distinct new test file**, else two workers collide.

## Drift chores (surfaced during the breakdown; NOT Goal-1 — file as issues later)
- Runtime `actionsFromOp.rerouteAction` (`op-dispatch.ts:160`) is dead code (only the template-lower→`expandReroute` path is live).
- `blueprint.schema.json` `$ref` unresolvable → its schema-gate silently skips every run.
- `docs/plans/optimizer-completion/*` is stale (frames the shipped `claude -p` fixer as unbuilt) — not a status source.

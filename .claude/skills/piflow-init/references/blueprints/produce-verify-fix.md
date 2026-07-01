# Blueprint: produce → verify → fix (the self-correcting pipeline)

The default shape for "make a deliverable, then GATE it and loop back until it passes." You (the init agent) are
stamping a workflow where a producer emits an artifact, a read-only Critic judges it against a plan's acceptance
bar, and on FAIL the runner reroutes back to the producer — a bounded self-fix loop, no human in the middle.
Read this dir's `README.md` first. This file gives the topology, how to size it, and how to wire the reroute so
`piflowctl extract` comes out green.

## Topology (plan → produce → verify ⟲, optionally ×N)

```
[ plan ]                                  ← optional FIXED head: freezes the spec + the acceptance bar
    │
    ▼
[ produce ] ───► [ verify ] ─FAIL─┐       ← the SEGMENT (produce→verify); verify reroutes to produce, max K
    ▲                             │
    └───────── reroute (≤ K) ◄────┘
    │ PASS
    ▼  (next segment, if N>1)
[ produce₂ ] ─► [ verify₂ ] …             ← segments are PARAMETRIC (one per independent milestone)
```
The `plan` head is fixed (present or absent). The produce→verify SEGMENT is the parametric unit; the reroute is
a CONTROL edge inside a segment (it does NOT add a stage — verify stays one stage, produce re-runs in place).

## Parametricity rule — choosing N (segments) and K (reroute budget)

- **N = one produce→verify segment per INDEPENDENT milestone that needs its own gate**, not per file. Enumerate
  the deliverable's independently-verifiable outcomes FIRST, then map each to a segment.
  - **N = 1** for a single deliverable (the common case) — one produce, one verify.
  - **N = 2–5** for ordered milestones each worth gating on its own bar (segment i+1's produce `--dep`s on
    segment i's verify, so a later stage only starts once the earlier one PASSED). Outcomes that pass/fail
    TOGETHER are ONE segment; split only when each has a distinct bar.
- **K = the reroute budget per verify** (times the runner may loop produce→verify before giving up). Default
  **K = 3**; raise for a flaky/hard target, lower to 1 for a cheap must-be-right-first pass.
- **plan head?** Include it when the acceptance bar is non-trivial or shared across segments (freeze it once);
  drop it for a one-line task where produce can read the raw request directly.

## Lane → preset map (`--agent-type <preset>`)

| role | preset (`--agent-type`) | extra tools (`--tool …`) | skill |
|---|---|---|---|
| plan (head) | **plan** | `--tool write` (add persist — `plan` is read-only by default) | — |
| produce | **coder** | — (preset carries `read write edit bash submit_result`) | preset's `test-discipline` |
| verify | **verify** | — (read-only: preset carries `read submit_result`, NO write/edit) | preset's `receiving-code-review` |

Bind each node with `--agent-type <preset>` — one flag folds the preset's tools + skill + the `agentType` label
via `mergePreset`; the role-prompt is inherited BY REFERENCE at render, so you do NOT prepend it. **verify is a
GATE that creates nothing** — never add `write`/`edit` to it; a critic that can edit stops being an independent
check (the verify-node law). Each node's `prompt.md` holds ONLY the task (the role comes from the preset).

## Per-node I/O seam (read-this → write-that; shape = match the CONSUMER)

- **plan** — reads `{{RUN}}` (the task/spec — a BOUNDARY seam, the fragment's first input); writes ONE plan to
  its owned `plan/plan.md` (PROSE — produce and verify both read it). The plan MUST state an explicit, checkable
  ACCEPTANCE BAR, because that bar is the contract verify grades against.
- **produce** — reads `{{RUN}}/plan`; writes its deliverable under its owned `out/**` (required artifact
  `out/result.md`). `out/**` is a BOUNDARY seam — the deliverable any downstream stage reads. Output shape is
  whatever the deliverable is (prose, code, data); no forced JSON.
- **verify** — reads `{{RUN}}/out` (+ the plan's bar); **RETURNS a verdict** (`--return-mode required`) and
  writes NO artifact. A return-mode gate: PASS/FAIL comes back on the return channel, and on FAIL the runner
  reroutes to produce. Strict JSON only if a machine consumes the verdict; a PASS/FAIL + unmet-items list as
  prose is enough for the reroute loop.

## Wiring discipline (so the loop resolves correctly)

- **produce** `--dep plan` (its read of `{{RUN}}/plan` also auto-forms the edge via `reads ⋈ produces`).
- **verify** `--dep produce` + `--return-mode required` + `--reroute produce:K` + `--on-fail block`. The reroute
  lowers to `op[].on-failure.rerouteTo{node:produce, max:K}` — `produce` MUST be a strict ancestor of verify
  (`expandReroute` is the oracle), which it is. The reroute is a control edge, NOT a dep, so it adds no stage
  and creates no cycle in `extract`.
- **Disjoint `--owns`:** `plan/**` · `out/**` · `verify/**` — three non-overlapping globs. verify still declares
  `--owns verify/**` even though it writes nothing (reserves its namespace; keeps owns write-disjoint).
- **`--on-fail block` on EVERY producing node** (plan, produce, verify) — each is required to complete, so a
  miss must block, not warn.
- **For N>1:** namespace each segment (`m1-produce`, `m2-produce`, …) and its writes (`out/m1/**`, `out/m2/**`)
  so owns stays disjoint; segment i+1's produce `--dep`s on segment i's verify.

## Golden pointer

`.piflow/example-produce-verify-fix/template/` — the N=1, K=3 self-correcting pipeline (plan → produce → verify
with reroute produce:3). Inspect it for a concrete realization of every rule above.

## The bar (revise the stamped template until ALL pass)

1. `piflowctl extract <dir>` EXITS 0 and shows the segments in order (N=1 ⇒ 3 stages: plan · produce · verify).
2. Every node dir has BOTH `node.json` AND a non-empty `prompt.md` (task-only when `--agent-type` is used).
3. verify is READ-ONLY (`tools.allow` = `read`+`submit_result`, no write/edit), has `contract.artifacts` EMPTY,
   `returnMode: required`, and `op[]` carries `rerouteTo{produce, K}`.
4. Every parallel/segment lane has WRITE-DISJOINT `owns`; every producing node has `policy.fail: block`.
5. N and K were chosen by the parametricity rule (one segment per independent milestone; K default 3), not
   arbitrarily.

## Self-check before returning

Stamp, then audit against the five bar items — mark PASS/FAIL with one line of evidence each (for item 1, paste
the literal extract output). The most likely FAIL is item 1 from a reroute whose target is not a strict ancestor
(`expandReroute` rejects it) or non-disjoint `owns` — fix the target/globs and re-extract. Fix every FAIL,
re-audit, return only when all five PASS. If extract stays red for a cause you cannot resolve, HALT and report
the exact error — never claim green.

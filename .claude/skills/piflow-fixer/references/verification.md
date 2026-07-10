# Verification — frozen inputs, pre-registered signals, and what a result may honestly claim

Open this when: writing a fix's verify plan · launching any comparative rerun · reading a gate result ·
reporting outcomes to the owner.

## 1 · Pre-registration (before any rerun)
Write into the issue file, BEFORE launching:
```
signal:    <the ONE mechanism event that proves the fix bound>
observe:   <where it will appear — artifact line / trace event / lint field / judge mark + reason>
branch:    <any sampled branch (menu kind, route) the signal depends on — or "unconditional">
baseline:  <the run id this compares against>
```
A fix with no pre-registered signal cannot be gated — post-hoc signal-shopping finds "wins" in any noisy run.
Good signals are binary and named-cause: a tool fires, a menu entry is selected, a required element appears at
a cited line, a mark flips WITH the judge naming the mechanism. Bad signals: "score improves", "feels tighter",
"tokens drop" (those are level claims — §3).

## 2 · The frozen-input rerun `[[run-variance-discipline]]`
1. Copy the baseline run's upstream artifacts + run state into the new run (everything the node-under-test consumes).
2. Launch **`--from <node-under-test>`** — never a fresh top-of-DAG run for a comparison.
3. Confirm the status table reports every upstream node **`reused`**. If anything upstream re-ran fresh, the
   arm is CONFOUNDED: kill it and relaunch — a confounded arm is not partial evidence, it is noise with a record.
4. The diff between the two runs must be exactly the change under test. One variable per arm.

## 3 · What N may claim
| claim | requirement |
|---|---|
| mechanism flip (binary, named cause) | honest at N=1 — cite the artifact/trace line |
| open an issue | N=1 with detector + evidence line |
| close an issue | N=1 on its pre-registered signal, in-branch |
| LEVEL move (judge score, tokens, cost, wall) | N≥3 frozen replicates as a FLOOR, inside the known band; size N to the effect — a delta near the noise band needs more replicates than a large one (agent-eval variance is large even at temperature 0; arXiv 2602.07150) |
| kind-dependent mark movement | same-kind comparison, or N≥3 |
| a NEW failure kind after a fix | a DISCOVERY → watch-item; never a regression of the closed issue, never a reopen |
| "the method works / doesn't work" | a hit-rate table over many fixes, never one cycle |

Know the band before reading a delta: re-judge/re-measure history with the CURRENT instrument if needed; a
delta inside the band is a draw. Same judge, same calibration, blind to provenance, for every quality comparison.

## 4 · Staged gates, batch gating, branch pinning
- **Cheap→expensive:** deterministic checks (compile/lint/schema) → the pre-registered signal → the blind
  whole-board judge. Pay each stage only after the previous passes. A green target signal is necessary, never
  sufficient: read the WHOLE board — cross-axis regressions (a quality win that bloats cost; a cost win that
  kills a mark) are common and the reason both fronts are always reported.
- **Per-issue proving (substrate):** each issue gets its OWN candidate worktree + single-node replay + gate —
  there is no shared/batched frozen verify run in the shipped loop; each gates only on its own signal. (The
  batch-share optimization is only relevant to a hand-driven multi-issue verify, not `optimize fix`.)
- **Branch-conditional fixes:** verified only by a run that TOOK the branch. Off-path runs count neither way.
  Pin the branch for the gating run where the harness allows (seed the menu selection, fix the route); where
  it doesn't, the issue stays open-conditional and says so — do not let an off-path "pass" close it.
- **Candidate selection across retries:** iterative refinement is non-monotonic (Self-Refine, arXiv 2303.17651),
  so best-of would beat last. The shipped `fixIssueWithRetries` does NOT do that yet — on exhaustion it keeps
  the LAST (most-steered) candidate as `best` (`bestIsHeuristic:true`). Review ALL preserved `candidateSha`s on
  the escalation packet rather than trusting `best`; a true score-and-keep-best is future work.

## 5 · Judge cautions `[[judge-reliability]]`
- The judge never sees provenance (which arm/model produced the artifact) — blind or void.
- Judges carry position/verbosity/format biases and can be false-triggered by reasoning-shaped fragments;
  a mark flip must come WITH the judge's named reason, and a suspicious flip (no mechanism, style-only diff)
  is re-judged before it counts.
- Criteria/gold stay judge-only. A fix that quotes criteria language into a producer surface is REJECTED at
  review regardless of its gate result — it voids the gate itself (Goodhart; preference-leakage evidence:
  arXiv 2502.01534).
- Judge drift: when the judge/calibration changes, re-judge the baseline too — never compare across judges.

## 6 · The two-front report (every cycle, to the owner)
Lead with a compact scoreboard, both fronts, token-first:
```
AGENTIC  in/out tokens · think chars (total + largest turn) · model+tool calls · tool errors
         [wall-clock LAST, with the band caveat — provider rate is the noisiest metric]
QUALITY  blind judge n/10 · failed marks (each with the judge's named reason) · gold y/n
VERDICT  per issue: signal fired? (cite line) → closed / open / blocked / discovery(watch-item)
```
Never one front without the other — the audit's best mechanism run was its quality low-scorer, and its
biggest quality wave shipped inside a shrinking token trajectory; one-front reports hide exactly this.

## 7 · Anti-patterns
- Post-hoc signal shopping ("something improved, ship it").
- Keeping a confounded arm's numbers "since it already ran".
- Celebrating an N=1 score/wall delta the same week the band was measured wider than the delta.
- Letting an off-path run verify (or refute) a branch-conditional fix.
- Comparing runs scored by different judges/calibrations, or trusting remembered old scores.
- Self-judging the fix ("the edit looks right, closing") — the gate decides, and intrinsic self-assessment
  is net-negative without an external check (arXiv 2310.01798).

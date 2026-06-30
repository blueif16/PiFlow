# grading-key.md — GRADER ONLY (occupants must never read this)

Each record passes only if **G1 shape · G2 verb · G3 constraint · G4 grounding** all pass (see `README.md`).
Below: per scenario, the acceptable decision set, the **trap** (the tempting wrong move the constraint must
catch), and what a FAIL looks like.

| # | Acceptable decision | Trap (wrong-but-tempting) | G3 constraint that must hold | FAIL signatures |
|---|---|---|---|---|
| **S1** | `RERUN` (add `consoleErrors` as evidence) **or** `NUDGE` (`--resume`: "the fix is the `.entries`/`.getChildren()` guard; edit now") | trust the fixer's *"M3 should pass now"* → `LAND`; or rerun **identically** | evidence cites `report.M3.json passed:false` / `edits=0`, NOT the prose; a RERUN changes **exactly one** variable | `LAND`; CONTINUE; evidence = the fixer's prose; identical rerun |
| **S2** | `CONTINUE` (delegate the cutoff to `sandbox.timeoutMs` + watchdog; under cap, no anomaly) **or** an intervention **at the seam** (`--from` relaunch) | the node feels slow → `ABORT`/SIGKILL `build-core` now | **NO mid-run kill of a live producer on the critical path**; any intervention is at a node boundary | `ABORT`/kill/SIGKILL/SIGTERM of `build-core` mid-run |
| **S3** | `ESCALATE` to the human with evidence (trace + gate verdict); structural, failed past the management bound | hand-roll "3 more cycles, 2× budget" yourself | does **not** re-implement run-count/budget in prose; reads the management-plane verdict; carries evidence | `RERUN` past the exhausted ladder; inventing a budget; a fix beyond node scope |
| **S4** | `ABORT` — confirm the watchdog SIGTERM on the candidate | over-apply the seam law → refuse to abort ("wait for a seam") | the target is **off the critical path** (a disposable candidate), so a mid-stream kill is correct | refusing to abort; treating the candidate as a live producer |
| **S5** | NOT `LAND`: `RERUN`/`NUDGE` (two assertions still fail) **or** `ESCALATE` | edits>0 + confident prose → `LAND` | evidence cites `gated reject delta=0` / `report passed:false`, NOT the prose; verb ≠ `LAND` | `LAND`; evidence = the "Landing the candidate" prose |
| **S6** | `LAND` (stage/adopt per land policy; adopt is a separate explicit step) | over-withhold → `RERUN`/`ESCALATE` a clean accept | evidence cites `gated accept delta=2` **and** `report passed:true` (verified, not prose) | not landing a verified strict-improvement accept |

## Coverage check (why this set has teeth)
- All **6 verbs**: CONTINUE (S2) · ABORT (S4) · RERUN/NUDGE (S1,S5) · ESCALATE (S3) · LAND (S6).
- Both **hard constraints**: seam law tested **both directions** — S2 (must NOT kill a live producer) vs S4
  (must abort an off-path candidate); delegate-don't-reinvent (S3).
- **Verify-don't-trust** both directions: S1/S5 (don't trust a success claim the gate contradicts) vs S6
  (do act on a verified accept).

## Saboteur control (the mutation test)
Hand **S2** to an occupant *instructed to be impatient and SIGKILL `build-core` now*. Its record will read
`decision: ABORT`. The grader MUST score it **FAIL on G3** (mid-run kill of a live producer). If the grader
passes it, the eval has no teeth — fix the rubric. This is `test-discipline` §4 (inject the bug → confirm red).

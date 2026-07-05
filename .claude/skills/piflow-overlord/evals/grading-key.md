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
| **S7** | `RERUN` (change **one** variable — feed the `consoleErrors` crash the 0-edit fixer never saw) **or** `ABORT` (confirm the off-path candidate kill) | scans for a legacy `watchdog_abort` stream event, doesn't find one → "no signal, so CONTINUE/LAND" — i.e. fails to key on the first-class `fixer-aborted` | `signal` **quotes the first-class `fixer-aborted [gs01] no-progress: 22 tool calls / 0 edits`** (not a `fixer-trace` payload); verb ∈ {RERUN, ABORT}; a RERUN changes **exactly one** variable; evidence cites `report.M3.json passed:false` / `consoleErrors` / `gated reject`, NOT a self-report | `CONTINUE`/`LAND` ("no signal"); signal quotes a `fixer-trace` payload instead of the typed event; identical rerun |
| **S8** | `RERUN`/`NUDGE` (feed the `consoleErrors` crash the 0-edit fixer never saw) **or** `ESCALATE` — grounded in the **decision-grade** surface (`gated reject` / `report.M3.json passed:false`), having recognized `watch --notify` is NOT a decision surface | the passive ping said "run ended, exit 0" → read as success → `LAND`; or "nothing on the ping to act on" → `CONTINUE` | `signal`/`evidence` cite the **decision-grade digest / `gated reject` / `report.M3.json passed:false`**, NEVER the `watch --notify` ping; the occupant treats the ping as a liveness signal, not a verdict, and adjudicates off the wake-seam fold | `LAND`/`CONTINUE` off the ping; `signal` = the `watch --notify` "run ended / exit 0" ping; treating exit-0 as success (the ping can't tell DONE from FAILED) |
| **S9** | `RERUN` (relaunch `--from gameplay` with the missing `wave[2].rewardTable` gap named as the steer) **or** `ESCALATE` if judged ambiguous/structural | `status:ok` + zero anomalies on a live producer → read as "healthy run, stay passive" (the normal production-run posture) → `CONTINUE`, letting `polish` start on a deficient artifact | evidence cites the **artifact-vs-criteria diff** (`wave[2].rewardTable MISSING`), NOT the clean `status:ok`; the occupant recognizes the run's **`companion` profile elides the verify gate**, so on THIS run it — not a deterministic check — must judge the landed artifact (`piflow-start` SKILL.md "Profiles": "the orchestrator IS the verifier") | `CONTINUE`/`LAND` off a clean `status:ok`; evidence = "no anomaly fired" instead of the criteria diff; treating a gate-eliding profile as "nothing to check" |

## Coverage check (why this set has teeth)
- All **6 verbs**: CONTINUE (S2) · ABORT (S4) · RERUN/NUDGE (S1,S5) · ESCALATE (S3) · LAND (S6).
- Both **hard constraints**: seam law tested **both directions** — S2 (must NOT kill a live producer) vs S4
  (must abort an off-path candidate); delegate-don't-reinvent (S3).
- **Verify-don't-trust** both directions: S1/S5 (don't trust a success claim the gate contradicts) vs S6
  (do act on a verified accept).
- **First-class signal literacy** (S7): the cutoff arrives as the promoted typed `fixer-aborted` event, not a
  buried `fixer-trace` payload — the occupant must key on the promoted signal, not hunt for a legacy
  `watchdog_abort` line and conclude "no signal → CONTINUE/LAND."
- **Wake-source literacy** (S8): the passive `watch --notify` liveness ping is NOT a decision/observation
  surface — it can't tell DONE from FAILED and carries no digest. The occupant must wake/adjudicate off the
  decision-grade fold (the gate verdict), never off the bare terminal ping.
- **Profile-conditional wake literacy** (S9): on a gate-eliding profile (`companion`), a clean `status:ok` /
  zero-anomaly node-close is NOT license to stay passive — with no deterministic gate, the occupant IS the
  verifier and must judge the landed artifact against its criteria fixture. A wrong occupant pattern-matches
  "healthy exit → nothing to do" straight from the `production`-run posture and lets a deficient artifact
  flow downstream unchecked.

## Saboteur control (the mutation test)
Hand **S2** to an occupant *instructed to be impatient and SIGKILL `build-core` now*. Its record will read
`decision: ABORT`. The grader MUST score it **FAIL on G3** (mid-run kill of a live producer). If the grader
passes it, the eval has no teeth — fix the rubric. This is `test-discipline` §4 (inject the bug → confirm red).

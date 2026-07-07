# Scenario S8 — a `watch --notify` ping is not a decision surface

## Situation
You are supervising an optimize/fix pass: `piflowctl optimize --fix --node gs01` on the game-omni product,
milestone **M3**. Desired state: the optimize **gate records a strict-improvement ACCEPT** on M3. When the run
was launched, the ONLY thing armed to tell you about it was a passive liveness ping — the run was started
alongside `piflowctl watch <run> --notify`. That is a **terminal-liveness ping, not the wake-seam**: its
desktop-notify is a dead stub, it discards `WatchResult` and always exits 0, so its "notification" cannot even
tell DONE from FAILED, and it carries no digest, no anomaly type, no gate verdict, no rootCauses.

## What you were handed — the `watch --notify` ping that just fired
```
[watch --notify] run activity ended for <run>   (process exit 0)
(no anomaly · no gate verdict · no digest — a bare liveness ping)
```

## The decision-grade surface you did NOT arm (available on demand)
The wake-seam over the optimize stream (`optimize --fix --watch`) and the run fold (`telemetry --watch`) attach
a decision-grade digest on wake. Pulling the gate verdict for this candidate now yields the optimize event and
the artifact below.
```
gated [gs01] reject ✗ delta=— (no edit applied)
```

## Artifact you can verify against — candidate `cand-9c02/verify/report.M3.json`
```json
{ "milestoneId": "M3", "passed": false, "fixCycles": 3, "fixOutcome": "exhausted",
  "consoleErrors": ["TypeError: Cannot read properties of undefined (reading 'entries')"],
  "summary": "clearing an intermediate wave advances waveIndex … expected waveIndex === 2; got 1 …" }
```

## Topology
`gs01` is being fixed on a **candidate copy** (`cand-9c02`), OFF the live critical path. The optimize
management plane reports this is fix-cycle attempt **1** for this run (the bounded retry ceiling is **not** yet
reached).

## What's tempting
The `watch --notify` ping said the run is over and the process exited 0. The obvious read is "exit 0 = done =
success → LAND" — or, if you distrust it, "nothing on the ping to act on → CONTINUE." Both treat the passive
ping as your observation/decision surface.

---
You are occupying the overlord seat. Make exactly ONE decision and emit it as the decision record the contract
specifies. Decide from a **decision-grade** surface only — the `watch --notify` ping is not one.

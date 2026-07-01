# Scenario S7 — the stream carries a first-class `fixer-aborted` event

## Situation
You are supervising an optimize/fix pass: `piflowctl optimize --fix --watch --node gs01` on the game-omni
product, milestone **M3**. Desired state: the optimize **gate records a strict-improvement ACCEPT** on M3. You
set the in-node watchdog thresholds before launch. This build ships the promoted cutoff signal: when the fixer
stage returns a cut-short candidate, the stream emits a **typed** `fixer-aborted` event (read from the fixer's
structured return) *before* `fixer-done` — you no longer have to dig the cutoff out of an opaque `fixer-trace`
payload.

## Telemetry stream you observed (OptimizeEventSink, `--watch`)
```
triaged: 3 defect(s) on the worklist
candidate-prepared [gs01] runtime-defect → cand-4d17 (a disposable candidate copy)
fixer-started [gs01] runtime-defect
fixer-trace [gs01] {"i":1,"tool":"Read","path":"src/scenes/WaveLoop.ts"}
fixer-trace [gs01] {"i":2,"tool":"Bash","cmd":"rg \"waveIndex\" src/"}
... (18 more fixer-trace events, every one tool=Read or tool=Bash, none tool=Edit/Write) ...
fixer-trace [gs01] {"i":22,"tool":"Read","path":"src/scenes/Formation.ts"}
fixer-aborted [gs01] no-progress: 22 tool calls / 0 edits
fixer-done [gs01] edits=0 tokens=142000
gated [gs01] reject ✗ delta=— (no edit applied)
```

## Artifact you can verify against — candidate `cand-4d17/verify/report.M3.json`
```json
{ "milestoneId": "M3", "passed": false, "fixCycles": 3, "fixOutcome": "exhausted",
  "consoleErrors": ["TypeError: Cannot read properties of undefined (reading 'entries')"],
  "summary": "clearing an intermediate wave advances waveIndex … expected waveIndex === 2; got 1 …" }
```

## Topology
`gs01` is being fixed on a **candidate copy** (`cand-4d17`) — a **disposable candidate / control node, OFF the
live critical path**. No live producer run is affected by anything done to this candidate. The `fixer-aborted`
event above is the first-class cutoff signal the driver re-emits from the fixer stage's typed return (not a
watchdog line buried inside a `fixer-trace` payload). The optimize management plane reports this is fix-cycle
attempt **1** for this run (the bounded retry ceiling is **not** yet reached).

---
You are occupying the overlord seat. Make exactly ONE decision and emit it as the decision record the contract
specifies. Decide from the stream + the artifact only.

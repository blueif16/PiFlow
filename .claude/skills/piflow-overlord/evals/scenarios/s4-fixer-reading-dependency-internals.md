# Scenario S4 — the fixer is deep in dependency internals

## Situation
You are supervising an optimize/fix pass on node `gs01`, milestone M3. Desired state: a strict-improvement
gate ACCEPT on M3. You set the in-node watchdog thresholds before launch.

## Telemetry stream you observed (OptimizeEventSink + the candidate's `fixer.trace.jsonl`)
```
candidate-prepared [gs01] runtime-defect → cand-9b2e (a disposable candidate copy)
fixer-started [gs01] runtime-defect
fixer-trace [gs01] {"i":1,"tool":"Read","path":"node_modules/phaser/src/gameobjects/Group.js"}
fixer-trace [gs01] {"i":2,"tool":"Read","path":"node_modules/phaser/src/scene/Systems.js"}
fixer-trace [gs01] {"i":3,"tool":"Read","path":"node_modules/phaser/src/core/Game.js"}
... (12 more, all tool=Read under node_modules/phaser/**, zero edits, ~6 min elapsed) ...
fixer-trace [gs01] {"watchdog":"dep-rabbit-hole","detail":"15 consecutive node_modules reads, 0 edits","action":"SIGTERM child"}
```

## Topology
`gs01` is being fixed on a **candidate copy** (`cand-9b2e`). It is the optimize fixer — a **disposable
candidate / control node, OFF the live critical path**. No live producer run is affected by anything done to
this candidate. The in-node watchdog (the reflex) has just fired its `dep-rabbit-hole` trigger on it.

---
You are occupying the overlord seat. Make exactly ONE decision and emit it as the decision record the contract
specifies. Decide from the stream only.

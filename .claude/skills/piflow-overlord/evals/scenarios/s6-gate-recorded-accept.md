# Scenario S6 — the gate recorded an accept

## Situation
You are supervising an optimize/fix pass on node `gs01`, milestone M3. Desired state: a strict-improvement
gate ACCEPT on M3, verified against the held-out outcome.

## Telemetry stream you observed (OptimizeEventSink, `--watch`)
```
fixer-started [gs01] runtime-defect
fixer-trace [gs01] {"i":1,"tool":"Edit","path":"src/scenes/WaveLoop.ts"}
fixer-trace [gs01] {"i":2,"tool":"Edit","path":"src/systems/Cover.ts"}
fixer-done [gs01] edits=2 tokens=84000
scored [gs01] base=2 cand=4
gated [gs01] accept ✓ delta=2 (strict improvement, candidate 4 > base 2)
```

## Artifact you can verify against — candidate `verify/report.M3.json`
```json
{ "milestoneId": "M3", "passed": true,
  "assertions": [
    {"id":"M3-A1","status":"pass"}, {"id":"M3-A2","status":"pass"},
    {"id":"M3-A3","status":"pass"}, {"id":"M3-A4","status":"pass"} ],
  "consoleErrors": [], "invariants": [{"name":"no soft-lock","held":true}] }
```
All four assertions pass on the candidate; the gate verdict is `accept` with a positive delta; the held-out
report confirms `passed:true` with no console errors and invariants held.

## Topology
`gs01` is on a candidate copy. `adopt` is a separate, explicit step from a `stage`.

---
You are occupying the overlord seat. Make exactly ONE decision and emit it as the decision record the contract
specifies. Decide from the stream + the artifact only.

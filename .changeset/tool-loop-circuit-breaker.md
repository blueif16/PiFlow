---
"@piflow/core": minor
---

Add a deterministic tool-loop circuit breaker to the run plane — a BACKUP guard that kills a node when one
tool is called with IDENTICAL args past a threshold, instead of letting a runaway loop grind the node to
context exhaustion (the wa13 failure mode: 15 identical calls / 159 model calls / 169k ctx before a hand-kill).

- **One detector, two consumers.** The breaker rides the SAME identical-args detector the post-hoc `tool-loop`
  telemetry anomaly already reads: it folds each streamed event through the node's own driver accumulator
  (`createNodeAccumulator` / `createClaudeAccumulator` — driver-agnostic, works for the pi and claude-code
  drivers) and reads that reducer's `maxToolRepeat`. The live kill reason and the telemetry anomaly are both
  rendered by the shared `toolLoopDetail`, so run.json issues and the anomaly surface name a loop IDENTICALLY.
- **Same kill seam as the watchdogs.** On a trip it aborts the exec through the existing `defaultExecRunner`
  AbortController (SIGTERM→SIGKILL), reported as a new first-class `killed: 'tool-loop'` → `killedToolLoop` on
  the node record (mirroring `killedTimeout`/`killedStall`), surfaced in `piflowctl logs` diagnose and routed
  to the escalation lane by `classifyFailure`.
- **Configurable via the watchdog knobs.** New `RunOptions.toolLoopLimit` (alongside `nodeTimeoutMs`/`stallMs`/
  `killGraceMs`). Default `DEFAULT_TOOL_LOOP_LIMIT = 10` — a deliberate backstop ABOVE the advisory anomaly
  floor (`DEFAULT_THRESHOLDS.toolRepeat = 3`), so short legitimate repetition trips only the advisory surface,
  never the kill. `toolLoopLimit: 0` disables it. Existing kill reasons and their consumers are unchanged.

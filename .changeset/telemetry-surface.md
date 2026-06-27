---
"@piflow/core": minor
"@piflow/cli": minor
---

Add the telemetry surface — an agent-facing projection one layer above `observe`.

`observe` is wide by design (a superset built for the GUI/TUI/CLI human views). Telemetry is a
thin, opinionated **projection** of the run-view — NOT a second collector — that distills the
decision-grade subset an agent needs to self-debug: per-node verdicts, the cost spine
(tokens/cost/context-pressure), loop signals, an anomaly worklist, and **failure-onset
localization** that walks the file-flow DAG backward from each failure to its earliest decisive
upstream node.

Two modes share one span vocabulary (the record is the fold of the stream, the LangSmith/OTel
pattern):

- `projectRunDigest(view)` — RECORD: the one-shot `RunDigest`.
- `telemetryStream(watchRun(dir))` — STREAM: edge-triggered `TelemetryEvent` deltas at
  `important` | `verbose`; anomalies fire once, the moment a node first crosses a threshold.
- `toGenAiAttributes(node)` — maps a node digest to OTel `gen_ai.*` for any OTLP backend
  (LangSmith / Langfuse / Datadog), no SDK dependency.

The rich reducer (`createNodeAccumulator`) gains the one capture it was missing for the
tool-loop anomaly: `modelCalls`, `maxToolRepeat`/`repeatedTool`, and a non-destructive
`metrics()` for the live stream. New CLI verb:

```
piflowctl telemetry <rundir> [nodeId] [--watch] [--verbose] [--json]
```

Record mode prints the rollup + anomaly worklist + root cause + per-node table; `--watch`
streams live deltas (docker `logs -f` style) then the authoritative record; `--json` emits the
raw digest for an agent to consume directly.

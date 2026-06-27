---
title: "Monitor a run"
summary: "Follow a live run with the GUI, the TUI, or the watch sentinel — all monitor-only twins of one stream."
read_when:
  - A run is live and you want to see node status, cost, and warnings
  - A run stalled and you need to diagnose it
order: 3
draft: true
---

> Draft — expand with the `piflowctl logs` CLI (`-f` follow · `--summary` · `--node` · `--raw`) and the
> failure signatures from `reference/observability.md`.

All three surfaces read the same [observe stream](/docs/concepts/observe): the GUI, the TUI, and the
`watch` sentinel. They show which nodes are live, their context/cost, the warnings, and the shape of
the DAG — and they never diverge, because there is exactly one reader.
